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

test('N9: a remainder inside [500ms, 1500ms) sends NOTHING (floor pinned)', async () => {
  let calls = 0;
  const requester = async () => {
    calls++;
    return { statusCode: 200, data: {} };
  };
  const r = await claimWithFallback({}, {
    keys,
    requester,
    perRequestTimeoutMs: 4000,
    totalDeadlineMs: 1000 // above the old 500ms floor, below the 1500ms one
  });
  // The old floor (500ms) sent a doomed request here: a client timeout on a
  // POST that may still have executed server-side (24h lock, possible
  // uncredited drip). The floor is now 1500ms — nothing may be sent.
  assert.equal(r.outcome, 'budget_exhausted');
  assert.equal(calls, 0, `a doomed attempt must not be started (made ${calls} calls)`);
});

test('N9: at/above the 1500ms floor an attempt still runs', async () => {
  let calls = 0;
  const requester = async () => {
    calls++;
    return { statusCode: 200, data: {} };
  };
  const r = await claimWithFallback({}, {
    keys,
    requester,
    totalDeadlineMs: 1600 // strictly above the floor
  });
  assert.equal(r.outcome, 'success');
  assert.equal(calls, 1);
});

test('a hopeless (<floor) remainder bails BEFORE the first attempt (nothing sent)', async () => {
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
  // N8/N9 semantics: even attempt #1 is skipped when the remainder cannot
  // fund a meaningful Circle call — a request sent now could still dispense
  // after the handler has been torn down, with no way to credit it.
  assert.equal(r.outcome, 'budget_exhausted');
  assert.equal(calls, 0, 'no Circle request may be sent on a hopeless budget');
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
