import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setKvClientForTests } from '../api/lib/kv.js';
import { createFakeKv } from './helpers/fake-kv.mjs';
import { mockReq, mockRes } from './helpers/harness.mjs';
import { updateAnalytics } from '../api/lib/analytics-kv.js';

import statsHandler from '../api/stats.js';

beforeEach(() => {
  setKvClientForTests(createFakeKv());
  process.env.CIRCLE_API_KEYS = 'TEST_API_KEY:a:b,TEST_API_KEY:c:d';
  process.env.STATS_CACHE_MS = '0'; // bypass cache unless a test opts in
  delete process.env.ADMIN_STATS_TOKEN;
});

const getStats = (headers = {}) => {
  const res = mockRes();
  return statsHandler(mockReq('GET', undefined, headers), res).then(() => res);
};

test('stats returns counters and honest storage type', async () => {
  await updateAnalytics('default', 'ETH-SEPOLIA', true, 1);
  const res = await getStats();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.totalClaims, 1);
  assert.equal(res.body.availableKeys, 2);
  assert.equal(res.body.currentKeyIndex, 0, 'recording usage does not advance rotation');
  assert.equal(res.body.keyUsage.key_1, 1);
  assert.equal(res.body.storageType, 'vercel-kv');
  assert.equal(res.body.warning, undefined);
});

test('stats flags degraded storage instead of pretending KV is healthy', async () => {
  setKvClientForTests({
    async get() {
      throw new Error('KV down');
    },
    async hgetall() {
      throw new Error('KV down');
    }
  });
  const res = await getStats();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.storageType, 'unavailable');
  assert.match(res.body.warning, /Failed to fetch/);
});

test('stats redacts key-pool details when ADMIN_STATS_TOKEN is set and header missing', async () => {
  process.env.ADMIN_STATS_TOKEN = 'sekrit';
  await updateAnalytics('default', 'ETH-SEPOLIA', true, 1);
  const res = await getStats();
  assert.deepEqual(res.body.keyUsage, {});
  assert.equal(res.body.availableKeys, 0);
  assert.equal(res.body.currentKeyIndex, 0);
  // non-sensitive aggregate data remains
  assert.equal(res.body.totalClaims, 1);
});

test('stats grants key-pool details with the correct admin token', async () => {
  process.env.ADMIN_STATS_TOKEN = 'sekrit';
  await updateAnalytics('default', 'ETH-SEPOLIA', true, 1);
  const res = await getStats({ 'x-admin-token': 'sekrit' });
  assert.equal(res.body.keyUsage.key_1, 1);
  assert.equal(res.body.availableKeys, 2);
});

test('M5: stats responses are cached for the configured TTL', async () => {
  process.env.STATS_CACHE_MS = '60000';
  await updateAnalytics('default', 'ETH-SEPOLIA', true, 1);
  const first = await getStats();
  // mutate underlying state — the cached snapshot must NOT reflect it
  await updateAnalytics('default', 'ETH-SEPOLIA', true, 1);
  const second = await getStats();
  assert.equal(first.body.totalClaims, 1);
  assert.equal(second.body.totalClaims, 1, 'served from cache');
});
