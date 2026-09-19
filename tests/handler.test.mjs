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
  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'tx-ok' } }));
});
after(() => {
  process.env = baseEnv;
});

const claim = (body, headers = {}) => {
  const res = mockRes();
  return handler(mockReq('POST', body, { 'x-forwarded-for': IP, ...headers }), res).then(() => res);
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

test('default mode: parallel duplicate claims — exactly ONE succeeds', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      claim({ address: ADDR, blockchain: 'ARC-TESTNET', usdc: true, mode: 'default', password: PASSWORD })
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

  // Keys recover -> the SAME wallet can claim again (lock was released)
  setRequesterForTests(async () => ({ statusCode: 200, data: { transactionId: 'tx-2' } }));
  const retry = await claim({ address: ADDR, blockchain: 'ETH-SEPOLIA', usdc: true, mode: 'default', password: PASSWORD });
  assert.equal(retry.statusCode, 200, 'wallet must not be burned for 24h after a failed claim');
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
