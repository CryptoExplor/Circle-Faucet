import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setKvClientForTests } from '../api/lib/kv.js';
import { createFakeKv } from './helpers/fake-kv.mjs';
import {
  updateAnalytics,
  advanceRotation,
  getAnalytics,
  resetAnalytics
} from '../api/lib/analytics-kv.js';

beforeEach(() => {
  setKvClientForTests(createFakeKv());
});

test('concurrent updateAnalytics never loses increments (the v2.1.0 lost-update bug)', async () => {
  const N = 50;
  await Promise.all(
    Array.from({ length: N }, () => updateAnalytics('default', 'ETH-SEPOLIA', true, 1))
  );
  const stats = await getAnalytics(3);
  assert.equal(stats.totalClaims, N, `expected ${N} total, got ${stats.totalClaims}`);
  assert.equal(stats.successfulClaims, N);
  assert.equal(stats.claimsByMode.default, N);
  assert.equal(stats.claimsByNetwork['ETH-SEPOLIA'], N);
  assert.equal(stats.keyUsage.key_1, N);
});

test('analytics counts successes and failures separately, sanitizes unknown modes', async () => {
  await updateAnalytics('default', 'ETH-SEPOLIA', true, 0);
  await updateAnalytics('own-key', 'BASE-SEPOLIA', false, null);
  await updateAnalytics('ATTACKER-MODE', 'ETH-SEPOLIA', false, null);

  const stats = await getAnalytics(2);
  assert.equal(stats.totalClaims, 3);
  assert.equal(stats.successfulClaims, 1);
  assert.equal(stats.failedClaims, 2);
  assert.equal(stats.claimsByMode.default, 1);
  assert.equal(stats.claimsByMode['own-key'], 1);
  // malicious/unknown mode is contained in the 'unknown' bucket
  assert.equal(stats.claimsByMode['ATTACKER-MODE'], undefined);
  assert.equal(stats.claimsByMode.unknown, 1);
  // sanitizes non-chain-looking network fields
  assert.equal(stats.claimsByNetwork['ETH-SEPOLIA'], 2);
});

test('rotation is fair and never out of range under concurrency', async () => {
  const N = 60;
  const results = await Promise.all(Array.from({ length: N }, () => advanceRotation(3)));
  const counts = [0, 0, 0];
  for (const r of results) {
    assert.ok(r.index >= 0 && r.index < 3, 'index within range');
    counts[r.index]++;
  }
  for (const c of counts) {
    assert.ok(Math.abs(c - N / 3) <= 1, `balanced distribution, got ${counts.join(',')}`);
  }
});

test('rotation survives key-count changes (no stale index 500s)', async () => {
  for (let i = 0; i < 7; i++) await advanceRotation(5); // counter now 7
  const { index } = await advanceRotation(2); // key pool shrank to 2
  assert.ok(index < 2, 'index must be within the NEW key count');
});

test('getCurrentKeyIndex reflects the last used key', async () => {
  assert.equal(await getCurrentSafe(4), 0);
  await advanceRotation(4);
  assert.equal(await getCurrentSafe(4), 0);
  await advanceRotation(4);
  assert.equal(await getCurrentSafe(4), 1);
});

async function getCurrentSafe(keyCount) {
  const { getCurrentKeyIndex } = await import('../api/lib/analytics-kv.js');
  return getCurrentKeyIndex(keyCount);
}

test('resetAnalytics zeroes all counters', async () => {
  await updateAnalytics('default', 'ARC-TESTNET', true, 2);
  await advanceRotation(3);
  const after = await resetAnalytics();
  assert.equal(after.totalClaims, 0);
  assert.equal(after.currentKeyIndex, 0);
  assert.deepEqual(after.claimsByNetwork, {});
});
