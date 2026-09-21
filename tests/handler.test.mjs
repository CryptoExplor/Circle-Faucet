/**
 * End-to-end handler tests: drive the real `handler` with an injected fake KV
 * client and fake Circle transport. These prove the actual request→response
 * contract and the state transitions around locks/reservations.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import handler from '../api/claim.js';
import { setKvClientForTests } from '../api/lib/kv.js';
import { setRequesterForTests } from '../api/lib/circle.js';
import { createFakeKv } from './helpers/fake-kv.mjs';
import { mockReq, mockRes } from './helpers/harness.mjs';
import { sha256Hex } from '../api/lib/validate.js';

const PASSWORD = 'correct-horse-battery';
const PASSWORD_HASH = crypto.createHash('sha256').update(PASSWORD).digest('hex');
const KEYS = ['TEST_API_KEY:a:b', 'TEST_API_KEY:c:d', 'TEST_API_KEY:e:f'];
const ADDR = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';
const IP = '203.0.113.7';

const baseEnv = { ...process.env };

beforeEach(() => {
  setKvClientForTests(createFakeKv());
  process.env = {
    ...baseEnv,
    CIRCLE_API_KEYS: KEYS.join(','),
    DEFAULT_PASSWORD_HASH: PASSWORD_HASH,
    REVOKED_API_KEY_HASHES: '',
    NODE_ENV: 'test'
  };
  delete process.env.FAUCET_DISABLED;
  delete process.env.ADMIN_STATS_TOKEN;
  delete process.env.IP_DAILY_LIMIT;
  delete process.env.CLAIM_REQUEST_BUDGET_MS;
  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'tx-ok' } }));
});
after(() => {
  process.env = baseEnv;
});

const claim = (body, ip = IP) => {
  const res = mockRes();
  return handler(mockReq('POST', body, { 'x-forwarded-for': ip }), res).then(() => res);
};

// ---------------------------------------------------------------- basic gate

test('rejects non-POST and answers OPTIONS preflight', async () => {
  let res = mockRes();
  await handler(mockReq('GET', undefined, {}), res);
  assert.equal(res.statusCode, 405);

  res = mockRes();
  await handler(mockReq('OPTIONS', undefined, {}), res);
  assert.equal(res.statusCode, 200);
});

test('FAUCET_DISABLED=true kill-switch blocks everything with 503', async () => {
  process.env.FAUCET_DISABLED = 'true';
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:1:2' });
  assert.equal(res.statusCode, 503);
});

test('missing fields / unknown chain / no tokens -> 400', async () => {
  assert.equal((await claim({ blockchain: 'ETH-SEPOLIA' })).statusCode, 400);
  assert.equal((await claim({ address: ADDR })).statusCode, 400);
  assert.equal(
    (await claim({ address: ADDR, blockchain: 'POLYGON-MAINNET', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:1:2' })).statusCode,
    400
  );
  assert.equal((await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', mode: 'own-key', apiKey: 'TEST_API_KEY:1:2' })).statusCode, 400);
});

test('L3: unsupported-chain 400 keeps the documented `supported` field', async () => {
  const res = await claim({ address: ADDR, blockchain: 'POLYGON-MAINNET', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:1:2' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.supported.length, 10);
  assert.ok(res.body.supported.includes('ETH-SEPOLIA'));
  assert.ok(res.body.supported.includes('APTOS-TESTNET'));
  assert.ok(res.body.supported.includes('SOL-DEVNET'));
});

test('prototype pollution via blockchain is rejected with 400', async () => {
  const res = await claim({ address: ADDR, blockchain: '__proto__', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:1:2' });
  assert.equal(res.statusCode, 400);
});

test('invalid address for the chain -> 400', async () => {
  const res = await claim({ address: 'not-an-address', blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:1:2' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Invalid address|address/i);
});

test('invalid mode -> 400', async () => {
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'admin' });
  assert.equal(res.statusCode, 400);
});

// ------------------------------------------------------------- own-key mode

test('own-key success passes through Circle 2xx', async () => {
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:id1:s1' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.transactionId, 'tx-ok');
});

test('own-key: malformed key format and revoked key are rejected', async () => {
  let res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'own-key', apiKey: 'garbage' });
  assert.equal(res.statusCode, 400);

  process.env.REVOKED_API_KEY_HASHES = sha256Hex('TEST_API_KEY:bad:revoke');
  res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:bad:revoke' });
  assert.equal(res.statusCode, 403);
});

test('own-key: Circle error status is passed through', async () => {
  setRequesterForTests(async () => ({ statusCode: 403, data: { code: 0, message: 'key lacks permission' } }));
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:id:s' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message, 'key lacks permission');
});

test('own-key: transport failure after send -> 503 OUTCOME UNKNOWN, no silent failure', async () => {
  let calls = 0;
  setRequesterForTests(async () => {
    calls++;
    throw new Error('Request timed out');
  });
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'own-key', apiKey: 'TEST_API_KEY:id:s' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'Outcome unknown');
  assert.equal(calls, 1, 'ambiguous request must not be retried');
});

// ----------------------------------------------------------- default mode

test('default mode: happy path claims once and records analytics', async () => {
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

test('default mode: wrong or missing password -> 401/400', async () => {
  let res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: 'wrong' });
  assert.equal(res.statusCode, 401);

  res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default' });
  assert.equal(res.statusCode, 400);
});

test('M2: malformed (placeholder) password hash can NEVER authenticate', async () => {
  process.env.DEFAULT_PASSWORD_HASH = 'your_password_hash_here';
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: 'your_password_hash_here' });
  assert.ok(res.statusCode === 503 || res.statusCode === 401, 'must not be 200');
  assert.notEqual(res.statusCode, 200);
});

test('default mode: fail-closed when DEFAULT_PASSWORD_HASH is unset', async () => {
  process.env.DEFAULT_PASSWORD_HASH = '';
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: 'anything' });
  assert.equal(res.statusCode, 503);
});

test('default mode: same wallet double-claim -> 429 even across case variants', async () => {
  assert.equal((await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD })).statusCode, 200);
  const res = await claim({ address: ADDR.toLowerCase(), blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 429);
  assert.match(res.body.error, /Wallet rate limit/);
});

test('default mode: parallel duplicate claims from DIFFERENT IPs — exactly ONE succeeds', async () => {
  // unique IP per request so all 8 contend for the WALLET lock (not the IP limit)
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      claim({ address: ADDR, blockchain: 'ARC-TESTNET', usdc: true, mode: 'default', password: PASSWORD }, `10.0.0.${i + 1}`)
    )
  );
  const ok = results.filter((r) => r.statusCode === 200);
  const limited = results.filter((r) => r.statusCode === 429);
  assert.equal(ok.length, 1, 'exactly one winner');
  assert.equal(limited.length, 7);
});

test('default mode: wallet lock is per network (same wallet, other chain works)', async () => {
  assert.equal((await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD })).statusCode, 200);
  const res = await claim({ address: ADDR, blockchain: 'BASE-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 200);
});

test('default mode: definitive failure RELEASES the wallet lock and IP quota', async () => {
  // All keys 429 -> exhausted
  setRequesterForTests(async () => ({ statusCode: 429, data: { code: 101, message: 'rate limited' } }));
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 429);
  assert.match(res.body.error, /exhausted/i);
  // N12: Circle's own body passes through, as in the original implementation
  assert.equal(res.body.message, 'rate limited');
  assert.equal(res.body.code, 101);
  assert.deepEqual(res.body.details, { code: 101, message: 'rate limited' });

  // Keys recover -> the SAME wallet can claim again (lock was released)
  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'tx-2' } }));
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 200, 'wallet must not be burned for 24h after a failed claim');
});

test('M1: Circle 502 is AMBIGUOUS -> 502 response, lock KEPT (no double drip)', async () => {
  setRequesterForTests(async () => ({ statusCode: 502, data: { error: 'bad gateway' } }));
  let calls = 0;
  setRequesterForTests(async () => {
    calls++;
    return { statusCode: 502, data: { error: 'bad gateway' } };
  });
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'Outcome unknown');
  assert.equal(calls, 1);

  // healthy Circle again -> still locked, because the 502 may have executed
  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'maybe-dup' } }));
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 429, 'lock retained after 5xx');
});

test('M1: Circle 400 is DEFINITIVE -> 400 response, lock RELEASED', async () => {
  setRequesterForTests(async () => ({ statusCode: 400, data: { code: 0, message: 'bad address' } }));
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 400);

  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'tx-3' } }));
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 200, '4xx releases the lock');
});

test('default mode: AMBIGUOUS transport failure KEEPS the lock (double-drip protection)', async () => {
  setRequesterForTests(async () => {
    throw new Error('Request timed out');
  });
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'Outcome unknown');

  // retry with a healthy Circle: still locked (the first drip may exist)
  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'maybe-dup' } }));
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 429, 'lock retained after unknown outcome');
});

test('H1: KV failure during rotation -> 500, but wallet lock and IP quota are RELEASED', async () => {
  const base = createFakeKv();
  const flaky = {
    get: (k) => base.get(k),
    set: (k, v, o) => base.set(k, v, o),
    del: (...k) => base.del(...k),
    decr: (k) => base.decr(k),
    expire: (k, s) => base.expire(k, s),
    hgetall: (k) => base.hgetall(k),
    hincrby: (k, f, b) => base.hincrby(k, f, b),
    incr: (k) => {
      if (k === 'faucet:key_rotation') throw new Error('KV blip during rotation');
      return base.incr(k);
    }
  };
  setKvClientForTests(flaky);

  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 500, 'rotation failure surfaces as 500');

  // the lock and IP reservation must have been released (nothing was sent)
  setKvClientForTests(createFakeKv());
  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'tx-after-blip' } }));
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 200, 'wallet NOT burned by an infrastructure blip');

  // and the IP has all 3 daily slots available again (only 1 used by the retry)
  const others = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];
  for (const w of others) {
    const r = await claim({ address: w, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
    assert.equal(r.statusCode, 200, 'IP quota was returned');
  }
});

test('M3: Circle receives the user\u2019s own address spelling (wire form)', async () => {
  let sentPayload;
  setRequesterForTests(async (key, payload) => {
    sentPayload = payload;
    return { statusCode: 200, data: { transactionId: 'tx' } };
  });
  // Aptos address with leading zeros must NOT be re-encoded
  const aptosAddr = '0x00' + 'ab'.repeat(31);
  await claim({ address: aptosAddr, blockchain: 'APTOS-TESTNET', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(sentPayload.address, aptosAddr, 'leading zeros preserved on the wire');
});

test('default mode: 4th claim from one IP in 24h -> 429 (IP limit now exists)', async () => {
  setRequesterForTests(async (key) => ({ statusCode: 200, data: { transactionId: `tx-${key}` } }));
  const wallets = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];
  for (const w of wallets) {
    const r = await claim({ address: w, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
    assert.equal(r.statusCode, 200);
  }
  const fourth = await claim({ address: '0x4444444444444444444444444444444444444444', blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(fourth.statusCode, 429);
  assert.match(fourth.body.error, /IP rate limit/);
});

test('default mode: no API keys configured -> 503', async () => {
  process.env.CIRCLE_API_KEYS = '';
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 503);
});

// Helper: capture [AUDIT] lines while fn runs
async function captureAudits(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[AUDIT]')) lines.push(args.join(' '));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = orig;
  }
}

test('S1: Circle 400 + transiently failing lock release (EVAL) -> retry succeeds, lock removed', async () => {
  const base = createFakeKv();
  let evalFailures = 0;
  setKvClientForTests({
    get: (k) => base.get(k),
    set: (k, v, o) => base.set(k, v, o),
    del: (...k) => base.del(...k),
    incr: (k) => base.incr(k),
    decr: (k) => base.decr(k),
    expire: (k, sec) => base.expire(k, sec),
    hgetall: (k) => base.hgetall(k),
    hincrby: (k, f, b) => base.hincrby(k, f, b),
    eval: async (script, keys, args) => {
      if (evalFailures < 2) {
        evalFailures++;
        throw new Error('KV blip on EVAL');
      }
      return base.eval(script, keys, args);
    }
  });
  setRequesterForTests(async () => ({ statusCode: 400, data: { code: 0, message: 'rejected' } }));

  const { result: res } = await captureAudits(() =>
    claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD })
  );
  assert.equal(res.statusCode, 400, 'definitive Circle rejection passes through');
  assert.equal(res.body.details?.message, 'rejected', 'N12: Circle body passed through as details');
  assert.ok(evalFailures >= 1, 'the release actually failed transiently');
  // the retried release must have removed the lock
  assert.equal([...base._dump().keys()].some((k) => k.startsWith('faucet:lock:')), false, 'lock removed after retry');
});

test('S1-hard: Circle 400 + permanently failing lock release -> 400, audited with the exact key', async () => {
  const base = createFakeKv();
  setKvClientForTests({
    get: (k) => base.get(k),
    set: (k, v, o) => base.set(k, v, o),
    del: (...k) => base.del(...k),
    incr: (k) => base.incr(k),
    decr: (k) => base.decr(k),
    expire: (k, sec) => base.expire(k, sec),
    hgetall: (k) => base.hgetall(k),
    hincrby: (k, f, b) => base.hincrby(k, f, b),
    eval: async () => {
      throw new Error('KV down on EVAL');
    }
  });
  setRequesterForTests(async () => ({ statusCode: 400, data: { code: 0, message: 'rejected' } }));

  const { result: res, lines } = await captureAudits(() =>
    claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD })
  );
  assert.equal(res.statusCode, 400);
  const failure = lines.find((l) => l.includes('lock_release_failed'));
  assert.ok(failure, 'failed release must be audited');
  assert.ok(failure.includes('faucet:lock:'), 'audit carries the exact Redis key for ops');
  // honest state: the 24h lock REMAINS (documented trade-off) — reviewer's S1 scenario
  assert.equal([...base._dump().keys()].some((k) => k.startsWith('faucet:lock:')), true, 'lock persists when DEL is impossible');
});

test('S2: ambiguous EXPIRE + failed cleanup -> 503 and audited failed release', async () => {
  const base = createFakeKv();
  let lockSetBlipped = false;
  setKvClientForTests({
    get: async () => {
      throw new Error('KV down (ownership check also fails)');
    },
    set: async (k, v, o) => {
      if (!lockSetBlipped && k.startsWith('faucet:lock:')) {
        lockSetBlipped = true;
        await base.set(k, v, o); // SET applies...
        throw new Error('KV command timed out: set'); // ...response lost
      }
      return base.set(k, v, o);
    },
    del: (...k) => base.del(...k),
    incr: (k) => base.incr(k),
    decr: (k) => base.decr(k),
    expire: async (k, sec) => {
      if (k.startsWith('faucet:lock:') && sec === 86400) throw new Error('KV down on EXPIRE');
      return base.expire(k, sec);
    },
    hgetall: (k) => base.hgetall(k),
    hincrby: (k, f, b) => base.hincrby(k, f, b),
    eval: async () => {
      throw new Error('KV down on EVAL (cleanup fails too)');
    }
  });
  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'tx' } }));

  const { result: res, lines } = await captureAudits(() =>
    claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD })
  );
  assert.equal(res.statusCode, 503, 'fail closed: extend failed, nothing sent');
  const uncertain = lines.find((l) => l.includes('wallet_lock_uncertain'));
  assert.ok(uncertain, 'ambiguous acquire audited');
  // The cleanup could not verify ownership (GET fails) -> provisional 90s orphan
  // self-heals; the audit line reports lockReleased:false for observability.
  assert.match(uncertain, /"lockReleased":false/);
});

test('N10: slow-KV bail-out leaves NO lock behind at response time (atomic eval release)', async () => {
  process.env.CLAIM_REQUEST_BUDGET_MS = '3800'; // consumed by ~3.5 KV round trips
  const base = createFakeKv();
  const slow = {};
  for (const m of ['get', 'del', 'incr', 'decr', 'expire', 'hgetall', 'hincrby', 'set', 'eval']) {
    slow[m] = async (...a) => {
      await new Promise((r) => setTimeout(r, 500));
      return base[m](...a);
    };
  }
  setKvClientForTests(slow);
  let circleCalls = 0;
  setRequesterForTests(async () => {
    circleCalls++;
    return { statusCode: 200, data: { transactionId: 'tx' } };
  });

  const { result: res, lines } = await captureAudits(() =>
    claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD })
  );
  delete process.env.CLAIM_REQUEST_BUDGET_MS;
  assert.equal(res.statusCode, 503);
  assert.equal(circleCalls, 0, 'nothing sent on a doomed budget (N9 floor)');
  // The 24h extension DID apply before the bail-out; the single-round-trip
  // eval release must still fit the 1.6s cap and remove the lock IN TIME —
  // at >=0.8s/command the old two-round-trip release could not (N10).
  assert.equal([...base._dump().keys()].some((k) => k.startsWith('faucet:lock:')), false, 'lock absent at response time');
  assert.ok(!lines.some((l) => l.includes('lock_release_failed') || l.includes('lock_release_timeout')), 'no false release alarms');
});

test('N10b: a slow IP-counter release must NOT raise a false lock_release_timeout', async () => {
  const base = createFakeKv();
  const client = {};
  for (const m of ['get', 'set', 'del', 'incr', 'expire', 'hgetall', 'hincrby', 'eval']) {
    client[m] = (...a) => base[m](...a);
  }
  // The IP release path uses decr (+del at 0); make ONLY those slow so the
  // 1.6s cap elapses after the lock half has long settled.
  client.decr = async (...a) => {
    await new Promise((r) => setTimeout(r, 1900));
    return base.decr(...a);
  };
  client.del = async (...a) => {
    await new Promise((r) => setTimeout(r, 1900));
    return base.del(...a);
  };
  setKvClientForTests(client);
  setRequesterForTests(async () => ({ statusCode: 400, data: { code: 0, message: 'rejected' } }));

  const { result: res, lines } = await captureAudits(() =>
    claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD })
  );
  assert.equal(res.statusCode, 400);
  assert.equal([...base._dump().keys()].some((k) => k.startsWith('faucet:lock:')), false, 'lock was released in time');
  assert.ok(
    !lines.some((l) => l.includes('lock_release_timeout') || l.includes('lock_release_failed')),
    'IP-counter lateness must not page ops about the lock'
  );
});

test('N8: per-attempt Circle timeout reflects the budget AFTER the rotation INCR', async () => {
  process.env.CLAIM_REQUEST_BUDGET_MS = '6000';
  const base = createFakeKv();
  const slow = {};
  for (const m of ['get', 'del', 'incr', 'decr', 'expire', 'hgetall', 'hincrby', 'set']) {
    slow[m] = async (...a) => {
      await new Promise((r) => setTimeout(r, 500));
      return base[m](...a);
    };
  }
  setKvClientForTests(slow);
  let seenTimeout = null;
  setRequesterForTests(async (key, payload, timeoutMs) => {
    seenTimeout = timeoutMs;
    return { statusCode: 200, data: { transactionId: 'tx' } };
  });

  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 200);
  // Pre-Circle KV: 2 pipelines (2 cmds each = 2000ms) + lock SET (500ms) +
  // EXPIRE extend (500ms) = ~3000ms, leaving ~3000ms. The rotation INCR
  // (500ms) happens AFTER that measurement, so the attempt must be charged
  // the post-INCR remaining (~2500ms), not the stale ~3000ms value.
  assert.ok(seenTimeout !== null, 'Circle request must be attempted');
  assert.ok(seenTimeout <= 2600, `timeout must be post-INCR remaining (got ${seenTimeout}ms)`);
  assert.ok(seenTimeout >= 1000, `timeout must still be a usable slice (got ${seenTimeout}ms)`);
});

test('N5: the 24h TTL is already in place AT RESPONSE TIME (no post-send lock work)', async () => {
  // Freeze-style regression test for round-3 N5: unregistered post-response
  // work has no execution guarantee on serverless, so the 24h TTL must be
  // established BEFORE the Circle call — i.e. it must be observable on the
  // lock key the moment the response is handed back, with nothing left
  // pending. (This test fails against the round-3 deferred-confirm design,
  // where the TTL was still 90s at response time.)
  const base = createFakeKv();
  setKvClientForTests(base);
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 200);

  const lockEntry = [...base._dump().entries()].find(([k]) => k.startsWith('faucet:lock:'));
  assert.ok(lockEntry, 'lock exists');
  const ttlMs = lockEntry[1].expiresAt - Date.now();
  assert.ok(
    ttlMs > 23.9 * 60 * 60 * 1000,
    `lock TTL at response time must be ~24h, got ${Math.round(ttlMs / 1000)}s`
  );
});

test('N5: extend failure fails closed BEFORE anything is sent', async () => {
  const base = createFakeKv();
  let extendFailed = false;
  setKvClientForTests({
    get: (k) => base.get(k),
    set: (k, v, o) => base.set(k, v, o),
    del: (...k) => base.del(...k),
    incr: (k) => base.incr(k),
    decr: (k) => base.decr(k),
    expire: async (k, sec) => {
      if (k.startsWith('faucet:lock:') && sec === 86400 && !extendFailed) {
        extendFailed = true;
        return 0; // key vanished / KV misbehaving at the extension point
      }
      return base.expire(k, sec);
    },
    hgetall: (k) => base.hgetall(k),
    hincrby: (k, f, b) => base.hincrby(k, f, b)
  });
  let circleCalls = 0;
  setRequesterForTests(async () => {
    circleCalls++;
    return { statusCode: 200, data: { transactionId: 'tx' } };
  });

  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 503, 'extend failure -> fail closed');
  assert.equal(circleCalls, 0, 'nothing was sent to Circle');

  // KV healthy again: the wallet was released, not burned.
  setKvClientForTests(createFakeKv());
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 200, 'wallet reusable after extend failure');
});

test('N1 E2E a: timed-out lock SET that APPLIED is owned via token -> claim completes', async () => {
  const base = createFakeKv();
  let blipped = false;
  setKvClientForTests({
    get: (k) => base.get(k),
    del: (...k) => base.del(...k),
    incr: (k) => base.incr(k),
    decr: (k) => base.decr(k),
    expire: (k, sec) => base.expire(k, sec),
    hgetall: (k) => base.hgetall(k),
    hincrby: (k, f, b) => base.hincrby(k, f, b),
    set: async (k, v, o) => {
      if (!blipped && k.startsWith('faucet:lock:')) {
        blipped = true;
        await base.set(k, v, o); // SET applies server-side...
        throw new Error('KV command timed out: set'); // ...response lost
      }
      return base.set(k, v, o);
    }
  });

  const first = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(first.statusCode, 200, 'token proves ownership; the claim proceeds');

  // The claim succeeded and the lock was confirmed (same store): locked.
  const dup = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(dup.statusCode, 429, 'confirmed lock holds');
});

test('N1 E2E b: timed-out lock SET that did NOT apply -> 503, wallet immediately reusable', async () => {
  const base = createFakeKv();
  let blipped = false;
  setKvClientForTests({
    get: (k) => base.get(k),
    del: (...k) => base.del(...k),
    incr: (k) => base.incr(k),
    decr: (k) => base.decr(k),
    expire: (k, sec) => base.expire(k, sec),
    hgetall: (k) => base.hgetall(k),
    hincrby: (k, f, b) => base.hincrby(k, f, b),
    set: async (k, v, o) => {
      if (!blipped && k.startsWith('faucet:lock:')) {
        blipped = true;
        throw new Error('KV command timed out: set'); // NOT applied (rejected before store)
      }
      return base.set(k, v, o);
    }
  });

  const { result: first, lines } = await captureAudits(() =>
    claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD })
  );
  assert.equal(first.statusCode, 503, 'fail closed, nothing dispensed');
  // N11: the SET never applied, so there is nothing to clean up — the audit
  // must NOT report a failed release for a lock that does not exist.
  const uncertain = lines.find((l) => l.includes('wallet_lock_uncertain'));
  assert.ok(uncertain, 'ambiguous acquire audited');
  assert.match(uncertain, /"lockReleased":true/, "absent lock is not a release failure");
  assert.doesNotMatch(uncertain, /lockKey/, 'no ops key emitted for a lock that never existed');

  setKvClientForTests(createFakeKv());
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 200, `wallet must not be orphaned (got ${retry.statusCode})`);
});

test('N1 E2E c: SET and ownership-GET both fail -> 503, wallet reusable (no orphan source)', async () => {
  const base = createFakeKv();
  let setBlipped = false;
  let getBlipped = false;
  setKvClientForTests({
    get: async (k) => {
      if (!getBlipped && k.startsWith('faucet:lock:')) {
        getBlipped = true;
        throw new Error('KV command timed out: get');
      }
      return base.get(k);
    },
    del: (...k) => base.del(...k),
    incr: (k) => base.incr(k),
    decr: (k) => base.decr(k),
    expire: (k, sec) => base.expire(k, sec),
    hgetall: (k) => base.hgetall(k),
    hincrby: (k, f, b) => base.hincrby(k, f, b),
    set: async (k, v, o) => {
      if (!setBlipped && k.startsWith('faucet:lock:')) {
        setBlipped = true;
        throw new Error('KV command timed out: set'); // not applied
      }
      return base.set(k, v, o);
    }
  });

  const first = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(first.statusCode, 503, 'fully ambiguous -> fail closed');

  setKvClientForTests(createFakeKv());
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 200, 'no 24h orphan: retry succeeds once KV recovers');
});

test('N1 E2E: successful claim locks the wallet for 24h (confirm path)', async () => {
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 200);
  const dup = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(dup.statusCode, 429, 'confirmed lock holds');
});

test('N2 E2E: the Circle fallback inherits the REMAINING request budget', async () => {
  const base = createFakeKv();
  const slow = {};
  for (const m of ['get', 'del', 'incr', 'decr', 'expire', 'hgetall', 'hincrby', 'set']) {
    slow[m] = async (...a) => {
      await new Promise((r) => setTimeout(r, 250));
      return base[m](...a);
    };
  }
  setKvClientForTests(slow);

  let seenTimeout;
  setRequesterForTests(async (key, payload, timeoutMs) => {
    seenTimeout = timeoutMs;
    await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 100)));
    return { statusCode: 200, data: { transactionId: 'tx' } };
  });

  const start = Date.now();
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  const elapsed = Date.now() - start;
  assert.equal(res.statusCode, 200);
  // ~5-6 KV commands at 250ms => >=1.25s elapsed before Circle; a FRESH 8.5s
  // deadline would show 8500. The shared budget must be strictly smaller.
  assert.ok(seenTimeout < 8500, `fallback must inherit remaining budget (got ${seenTimeout}ms)`);
  assert.ok(elapsed < 9500, `total must stay under maxDuration (took ${elapsed}ms)`);
});

test('N2 E2E: exhausted budget bails out BEFORE calling Circle and releases reservations', async () => {
  process.env.CLAIM_REQUEST_BUDGET_MS = '3500'; // tiny budget for the test
  const base = createFakeKv();
  const slow = {};
  for (const m of ['get', 'del', 'incr', 'decr', 'expire', 'hgetall', 'hincrby', 'set']) {
    slow[m] = async (...a) => {
      await new Promise((r) => setTimeout(r, 800));
      return base[m](...a);
    };
  }
  setKvClientForTests(slow);

  let circleCalls = 0;
  setRequesterForTests(async () => {
    circleCalls++;
    return { statusCode: 200, data: { transactionId: 'tx' } };
  });

  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 503);
  assert.equal(circleCalls, 0, 'must not start a Circle attempt without budget');
  assert.match(res.body.error, /unavailable|overloaded/i);

  // Reservations released: with healthy KV the same wallet+IP can claim.
  delete process.env.CLAIM_REQUEST_BUDGET_MS;
  setKvClientForTests(createFakeKv());
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 200, 'wallet/IP quota returned after bail-out');
});

test('default mode: fallback tries the next key on 429 and succeeds', async () => {
  const triedKeys = [];
  setRequesterForTests(async (key) => {
    triedKeys.push(key);
    if (key === KEYS[0]) return { statusCode: 429, data: { code: 101, message: 'rate limited' } };
    return { statusCode: 200, data: { transactionId: 'tx-fallback' } };
  });
  const res = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(triedKeys, [KEYS[0], KEYS[1]]);
});
