import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setKvClientForTests } from '../api/lib/kv.js';
import { createFakeKv } from './helpers/fake-kv.mjs';
import { claimWithFallback } from '../api/lib/circle.js';

beforeEach(() => {
  setKvClientForTests(createFakeKv());
});

const keys = ['K0', 'K1', 'K2'];

test('success on first key stops immediately', async () => {
  let calls = 0;
  const requester = async (key) => {
    calls++;
    assert.equal(key, 'K0');
    return { statusCode: 200, data: { transactionId: 'tx1' } };
  };
  const r = await claimWithFallback({}, { keys, requester });
  assert.equal(r.outcome, 'success');
  assert.equal(r.keyIndex, 0);
  assert.equal(calls, 1);
});

test('definitive 429 advances to the next key and then succeeds', async () => {
  const tried = [];
  const requester = async (key) => {
    tried.push(key);
    if (key === 'K0') return { statusCode: 429, data: { code: 101, message: 'rate limited' } };
    return { statusCode: 200, data: { transactionId: 'tx2' } };
  };
  const r = await claimWithFallback({}, { keys, requester });
  assert.equal(r.outcome, 'success');
  assert.deepEqual(tried, ['K0', 'K1'], 'starts at rotation index 0, advances after 429');
  assert.equal(r.keyIndex, 1);
});

test('all keys 429 -> outcome exhausted (no infinite loop)', async () => {
  let calls = 0;
  const requester = async () => {
    calls++;
    return { statusCode: 429, data: { code: 101, message: 'rate limited' } };
  };
  const r = await claimWithFallback({}, { keys, requester });
  assert.equal(r.outcome, 'exhausted');
  assert.equal(calls, keys.length, 'tries every configured key once');
});

test('non-429 Circle error is DEFINITIVE: no retry on other keys', async () => {
  let calls = 0;
  const requester = async () => {
    calls++;
    return { statusCode: 400, data: { code: 0, message: 'bad address' } };
  };
  const r = await claimWithFallback({}, { keys, requester });
  assert.equal(r.outcome, 'circle_error');
  assert.equal(calls, 1, 'never retries a definitive rejection');
  assert.equal(r.response.statusCode, 400);
});

test('transport error is AMBIGUOUS: never retried (double-drip protection)', async () => {
  let calls = 0;
  const requester = async () => {
    calls++;
    throw new Error('Request timed out');
  };
  const r = await claimWithFallback({}, { keys, requester });
  assert.equal(r.outcome, 'unknown');
  assert.equal(calls, 1, 'must NOT re-send a possibly-executed POST');
  assert.equal(r.error.message, 'Request timed out');
});

test('total deadline bounds retry attempts', async () => {
  let calls = 0;
  const requester = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 400));
    return { statusCode: 429, data: {} };
  };
  const start = Date.now();
  const r = await claimWithFallback({}, {
    keys,
    requester,
    perRequestTimeoutMs: 4000,
    totalDeadlineMs: 1000
  });
  const elapsed = Date.now() - start;
  assert.equal(r.outcome, 'exhausted');
  assert.ok(calls < keys.length, `deadline must cut retries short (made ${calls} calls)`);
  assert.ok(elapsed < 1500, `must respect deadline, took ${elapsed}ms`);
});

test('the first attempt always runs even if the budget is already tight', async () => {
  let calls = 0;
  const requester = async () => {
    calls++;
    return { statusCode: 429, data: {} };
  };
  const r = await claimWithFallback({}, {
    keys,
    requester,
    totalDeadlineMs: 1 // pathological: no budget at all
  });
  assert.equal(r.outcome, 'exhausted');
  assert.equal(calls, 1, 'attempt #1 must never be skipped');
});

test('maxAttempts caps fallback regardless of key count', async () => {
  let calls = 0;
  const requester = async () => {
    calls++;
    return { statusCode: 429, data: {} };
  };
  await claimWithFallback({}, { keys: ['K0', 'K1', 'K2', 'K3', 'K4'], requester });
  assert.equal(calls, 3, 'capped at 3 attempts');
});

test('M1: gateway 5xx (502/504) is AMBIGUOUS: never retried, status surfaced', async () => {
  for (const status of [500, 502, 504]) {
    let calls = 0;
    const requester = async () => {
      calls++;
      return { statusCode: status, data: { error: 'bad gateway' } };
    };
    const r = await claimWithFallback({}, { keys, requester });
    assert.equal(r.outcome, 'unknown', `${status} must be unknown`);
    assert.equal(r.statusCode, status);
    assert.equal(calls, 1, 'never re-sent after a possible execution');
  }
});

test('M1: 408 request timeout is AMBIGUOUS', async () => {
  const requester = async () => ({ statusCode: 408, data: {} });
  const r = await claimWithFallback({}, { keys, requester });
  assert.equal(r.outcome, 'unknown');
  assert.equal(r.statusCode, 408);
});

test('4xx (other than 408/429) is definitive: circle_error, no retry', async () => {
  for (const status of [400, 401, 403]) {
    let calls = 0;
    const requester = async () => {
      calls++;
      return { statusCode: status, data: { code: 0, message: 'rejected' } };
    };
    const r = await claimWithFallback({}, { keys, requester });
    assert.equal(r.outcome, 'circle_error', `${status} is definitive`);
    assert.equal(calls, 1);
  }
});
