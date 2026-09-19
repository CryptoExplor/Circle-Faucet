import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setKvClientForTests } from '../api/lib/kv.js';
import { createFakeKv } from './helpers/fake-kv.mjs';
import {
  acquireWalletLock,
  releaseWalletLock,
  reserveIpDailyClaim,
  releaseIpDailyClaim,
  checkInfraLimit
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
  assert.equal(results.filter(Boolean).length, 1, 'exactly one acquirer');
  assert.equal(results.filter((r) => !r).length, N - 1, 'everyone else rejected');
});

test('wallet lock: contract — inputs are ALREADY-canonical identities', async () => {
  // The handler canonicalizes (validate.js) before acquiring the lock; the
  // end-to-end case-variant bypass is covered in handler.test.mjs.
  const canon = (a) => canonicalizeAddress(a, 'ETH-SEPOLIA');
  const a = await acquireWalletLock(canon('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B').identity, 'ETH-SEPOLIA');
  const b = await acquireWalletLock(canon('0XAB5801A7D398351B8BE11C439E05C5B3259AEC9B').identity, 'ETH-SEPOLIA');
  assert.equal(a, true);
  assert.equal(b, false, 'case variant collapses to same canonical identity');
});

test('wallet lock release allows a second claim', async () => {
  assert.equal(await acquireWalletLock('0xabc', 'ARC-TESTNET'), true);
  await releaseWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(await acquireWalletLock('0xabc', 'ARC-TESTNET'), true);
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
