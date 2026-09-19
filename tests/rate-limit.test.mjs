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
});

test('wallet lock: exactly ONE of N concurrent claims wins (atomic SET NX)', async () => {
  const N = 25;
  const results = await Promise.all(
    Array.from({ length: N }, () => acquireWalletLock('0xabc', 'ETH-SEPOLIA'))
  );
  assert.equal(results.filter(Boolean).length, 1, 'exactly one acquirer');
  assert.equal(results.filter((r) => !r).length, N - 1, 'everyone else rejected');
});

test('wallet lock: contract — inputs are ALREADY-canonical addresses', async () => {
  // The handler canonicalizes (validate.js) before acquiring the lock; the
  // end-to-end case-variant bypass is covered in handler.test.mjs. Here we
  // assert the lock itself is identity-based on the canonical form.
  const canon = (a) => canonicalizeAddress(a, 'ETH-SEPOLIA');
  const a = await acquireWalletLock(canon('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B'), 'ETH-SEPOLIA');
  const b = await acquireWalletLock(canon('0XAB5801A7D398351B8BE11C439E05C5B3259AEC9B'), 'ETH-SEPOLIA');
  const c = await acquireWalletLock(canon('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B '.trim()), 'ETH-SEPOLIA');
  assert.equal(a, true);
  assert.equal(b, false, 'case variant collapses to same canonical identity');
  assert.equal(c, false, 'same canonical wallet is locked out');
});

test('wallet lock release allows a second claim', async () => {
  assert.equal(await acquireWalletLock('0xabc', 'ARC-TESTNET'), true);
  await releaseWalletLock('0xabc', 'ARC-TESTNET');
  assert.equal(await acquireWalletLock('0xabc', 'ARC-TESTNET'), true);
});

test('IP daily limit: 4th claim within 24h is blocked, releases free quota', async () => {
  for (let i = 0; i < 3; i++) {
    const r = await reserveIpDailyClaim('1.2.3.4');
    assert.equal(r.allowed, true, `claim ${i + 1} allowed`);
  }
  const fourth = await reserveIpDailyClaim('1.2.3.4');
  assert.equal(fourth.allowed, false, '4th blocked');

  await releaseIpDailyClaim('1.2.3.4');
  const afterRelease = await reserveIpDailyClaim('1.2.3.4');
  assert.equal(afterRelease.allowed, true, 'released quota is reusable');
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
  // other IPs unaffected
  assert.equal((await checkInfraLimit('other-ip')).allowed, true);
});

test('infra limit fails OPEN when KV is unavailable (BYO-key mode stays up)', async () => {
  setKvClientForTests({
    async incr() {
      throw new Error('KV down');
    }
  });
  const r = await checkInfraLimit('1.1.1.1');
  assert.equal(r.allowed, true, 'fail-open');
});
