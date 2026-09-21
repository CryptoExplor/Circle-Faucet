import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setKvClientForTests } from '../api/lib/kv.js';
import { createFakeKv } from './helpers/fake-kv.mjs';
import {
  acquireWalletLock,
  extendWalletLock,
  releaseWalletLock,
  reserveIpDailyClaim,
  releaseIpDailyClaim,
  checkInfraLimit,
  WALLET_LOCK_PROVISIONAL_TTL_SECONDS,
  WALLET_LOCK_TTL_SECONDS
} from '../api/lib/rate-limit.js';
import { canonicalizeAddress } from '../api/lib/validate.js';

beforeEach(() => {
  setKvClientForTests(createFakeKv());
  delete process.env.IP_DAILY_LIMIT;
});

test('wallet lock: exactly ONE of N concurrent claims wins (atomic SET NX)', async () => {
  const N = 25;
  const results = await Promise.all(
    Array.from({ length: N }, () => acquireWalletLock('0xabc', 'ETH-SEPOLIA'))
  );
  assert.equal(results.filter((r) => r.acquired).length, 1, 'exactly one acquirer');
  assert.equal(results.filter((r) => !r.acquired && !r.ambiguous).length, N - 1, 'everyone else contested');
  // every acquirer holds a unique token
  const tokens = results.map((r) => r.token);
  assert.equal(new Set(tokens).size, N, 'tokens are unique per request');
});

test('wallet lock: contract — inputs are ALREADY-canonical identities', async () => {
  // The handler canonicalizes (validate.js) before acquiring the lock; the
  // end-to-end case-variant bypass is covered in handler.test.mjs.
  const canon = (a) => canonicalizeAddress(a, 'ETH-SEPOLIA');
  const a = await acquireWalletLock(canon('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B').identity, 'ETH-SEPOLIA');
  const b = await acquireWalletLock(canon('0XAB5801A7D398351B8BE11C439E05C5B3259AEC9B').identity, 'ETH-SEPOLIA');
  assert.equal(a.acquired, true);
  assert.equal(b.acquired, false, 'case variant collapses to same canonical identity');
});

test('N5: extendWalletLock establishes 24h write-ahead and preserves the token', async () => {
  const base = createFakeKv();
  const ops = [];
  setKvClientForTests({
    ...base,
    set: async (k, v, o) => {
      if (k.startsWith('faucet:lock:')) ops.push(['set', o]);
      return base.set(k, v, o);
    },
    expire: async (k, sec) => {
      if (k.startsWith('faucet:lock:')) ops.push(['expire', sec]);
      return base.expire(k, sec);
    }
  });
  const l = await acquireWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(l.acquired, true);
  assert.equal(ops[0][1].ex, WALLET_LOCK_PROVISIONAL_TTL_SECONDS, 'acquire TTL is provisional (90s)');
  assert.equal(await extendWalletLock('0xabc', 'ARC-TESTNET', l.token), true, 'write-ahead extend succeeds');
  assert.equal(ops[1][1], WALLET_LOCK_TTL_SECONDS, 'extend sets the 24h TTL');
  // EXPIRE must not touch the value: ownership token survives the extension
  const entry = [...base._dump().entries()].find(([k]) => k.startsWith('faucet:lock:'));
  assert.equal(entry[1].value, l.token);
});

test('N5: extend on a vanished lock returns false (caller fails closed)', async () => {
  setKvClientForTests(createFakeKv());
  assert.equal(await extendWalletLock('0xabc', 'ARC-TESTNET', 'tok'), false);
});

test('N1: timed-out SET that still applied is detected via the token', async () => {
  const base = createFakeKv();
  let firstLockSet = true;
  setKvClientForTests({
    ...base,
    set: async (k, v, o) => {
      if (firstLockSet && k.startsWith('faucet:lock:')) {
        firstLockSet = false;
        await base.set(k, v, o); // applies server-side...
        throw new Error('KV command timed out: set'); // ...response lost
      }
      return base.set(k, v, o);
    }
  });
  const l = await acquireWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(l.acquired, true, 'ownership recovered via GET token compare');
  assert.equal(l.ambiguous, true);
  // owner can release it by token; a stranger's token cannot
  assert.equal(await releaseWalletLock('0xabc', 'ARC-TESTNET', 'not-my-token'), 'absent');
  assert.equal(await releaseWalletLock('0xabc', 'ARC-TESTNET', l.token), 'released');
});

test('N1: fully-unavailable KV yields ambiguous NOT-acquired, never a 24h orphan source', async () => {
  setKvClientForTests({
    get: async () => { throw new Error('KV down'); },
    set: async () => { throw new Error('KV down'); },
    del: async () => { throw new Error('KV down'); },
    incr: async () => { throw new Error('KV down'); }
  });
  const l = await acquireWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(l.acquired, false);
  assert.equal(l.ambiguous, true, 'caller must know cleanup is needed');
});

test('release tri-state: absent / released / failed (N11)', async () => {
  const base = createFakeKv();
  setKvClientForTests(base);
  // absent: nothing was ever locked
  assert.equal(await releaseWalletLock('0xabc', 'ARC-TESTNET', 'some-token'), 'absent');
  // released
  const l = await acquireWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(await releaseWalletLock('0xabc', 'ARC-TESTNET', l.token), 'released');
  // failed: KV misbehaves on every attempt (eval AND legacy get/del)
  setKvClientForTests({
    get: async () => { throw new Error('KV down'); },
    del: async () => { throw new Error('KV down'); },
    eval: async () => { throw new Error('KV down'); }
  });
  assert.equal(await releaseWalletLock('0xabc', 'ARC-TESTNET', 'x'.repeat(32)), 'failed');
});

test('release uses the single-round-trip eval path when the client offers it', async () => {
  const base = createFakeKv();
  let evalCalls = 0;
  let getCalls = 0;
  const client = {};
  for (const m of ['get', 'set', 'del', 'incr', 'decr', 'expire', 'hgetall', 'hincrby', 'eval']) {
    client[m] = (...a) => base[m](...a);
  }
  client.get = async (k) => { getCalls++; return base.get(k); };
  client.eval = async (script, keys, args) => { evalCalls++; return base.eval(script, keys, args); };
  setKvClientForTests(client);
  const l = await acquireWalletLock('0xabc', 'ARC-TESTNET');
  const released = await releaseWalletLock('0xabc', 'ARC-TESTNET', l.token);
  assert.equal(released, 'released');
  assert.equal(evalCalls, 1, 'one atomic command');
  assert.equal(getCalls, 0, 'no separate ownership GET round trip');
});

test('release falls back to GET-compare-then-DEL on clients without eval', async () => {
  const base = createFakeKv();
  const client = {};
  for (const m of ['get', 'set', 'del', 'incr', 'decr', 'expire', 'hgetall', 'hincrby']) {
    client[m] = (...a) => base[m](...a);
  }
  setKvClientForTests(client); // note: no eval — legacy path
  const l = await acquireWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(await releaseWalletLock('0xabc', 'ARC-TESTNET', 'wrong-token'), 'absent');
  assert.equal(await releaseWalletLock('0xabc', 'ARC-TESTNET', l.token), 'released');
  assert.equal(await base.get('__nonexistent__'), null);
});

test('wallet lock release (ownership-checked) allows a second claim', async () => {
  const l = await acquireWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(l.acquired, true);
  await releaseWalletLock('0xabc', 'ARC-TESTNET', l.token);
  const again = await acquireWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(again.acquired, true);
});

test('IP daily limit: 4th claim within 24h is blocked, release frees quota', async () => {
  let day;
  for (let i = 0; i < 3; i++) {
    const r = await reserveIpDailyClaim('1.2.3.4');
    assert.equal(r.allowed, true, `claim ${i + 1} allowed`);
    day = r.day;
  }
  const fourth = await reserveIpDailyClaim('1.2.3.4');
  assert.equal(fourth.allowed, false, '4th blocked');
  assert.equal(fourth.resetTime.getTime() % 86400000, 0, 'resetTime is the true UTC bucket end');

  await releaseIpDailyClaim('1.2.3.4', day); // return one of the granted slots
  const afterRelease = await reserveIpDailyClaim('1.2.3.4');
  assert.equal(afterRelease.allowed, true, 'released quota is reusable');
});

test('L2: release uses the caller-provided day bucket (midnight-safe)', async () => {
  const DAY = 86400000;
  const lateNight = 2 * DAY - 1000; // 23:59:59 UTC of "day 1"
  const justAfterMidnight = 2 * DAY + 1000; // 00:00:01 UTC of "day 2"

  const r = await reserveIpDailyClaim('5.6.7.8', { now: lateNight });
  assert.equal(r.allowed, true);
  assert.equal(r.day, 1);

  // Releasing on the NEXT day must decrement the ORIGINAL day bucket...
  await releaseIpDailyClaim('5.6.7.8', r.day, { now: justAfterMidnight });

  // ...so the same day still has full quota (slot was returned, then used):
  const again = await reserveIpDailyClaim('5.6.7.8', { now: lateNight });
  assert.equal(again.allowed, true);
});

test('M4: IP daily limit is configurable via env', async () => {
  process.env.IP_DAILY_LIMIT = '1';
  const first = await reserveIpDailyClaim('7.7.7.7');
  const second = await reserveIpDailyClaim('7.7.7.7');
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
});

test('IP daily reservations are per-IP and atomic under concurrency', async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, () => reserveIpDailyClaim('9.9.9.9'))
  );
  assert.equal(results.filter((r) => r.allowed).length, 3, 'only 3 of 10 pass');
});

test('infra limit blocks after 100 requests in the hour window', async () => {
  for (let i = 0; i < 100; i++) {
    const r = await checkInfraLimit('bad-actor');
    assert.equal(r.allowed, true, `request ${i + 1} allowed`);
  }
  const over = await checkInfraLimit('bad-actor');
  assert.equal(over.allowed, false, '101st blocked');
  assert.equal(over.resetTime.getTime() % 3600000, 0, 'resetTime is the true UTC hour bucket end');
  assert.equal((await checkInfraLimit('other-ip')).allowed, true);
});

test('H2: fail-open policy runs within the KV command deadline (hanging KV)', async () => {
  const { setKvTimeoutForTests } = await import('../api/lib/kv.js');
  setKvTimeoutForTests(50);
  setKvClientForTests({
    incr: () => new Promise(() => {}) // hang forever
  });
  const start = Date.now();
  const r = await checkInfraLimit('1.1.1.1');
  const elapsed = Date.now() - start;
  assert.equal(r.allowed, true, 'fail-open');
  assert.ok(elapsed < 500, `must not wait on the hanging KV (took ${elapsed}ms)`);
  setKvTimeoutForTests(0); // restore default for other tests
});

test('N3: IPv4-mapped IPv6 unwrap + case folding (unit)', async () => {
  const { clientIpBucket } = await import('../api/lib/validate.js');
  assert.equal(clientIpBucket('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(clientIpBucket('::FFFF:5.6.7.8'), '5.6.7.8');
  assert.notEqual(clientIpBucket('::ffff:1.2.3.4'), clientIpBucket('::ffff:5.6.7.8'), 'mapped clients must not share a bucket');
  assert.equal(clientIpBucket('2001:DB8::1'), clientIpBucket('2001:db8::1'), 'case-insensitive');
  assert.equal(clientIpBucket('2001:db8:1:2:3:4:5:6'), '2001:0db8:0001:0002:/64');
});
