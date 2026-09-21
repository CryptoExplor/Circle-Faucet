/**
 * Circle faucet API client (POST /v1/faucet/drips) with bounded,
 * ambiguity-safe fallback across the configured API keys.
 *
 * Retry semantics (v2.1.2) — a faucet drip is a NON-IDEMPOTENT POST, and a
 * rejected-vs-executed distinction must be conservative:
 *   - 2xx                       -> definitive success, stop.
 *   - 429                       -> definitive rejection by Circle (nothing was
 *                                  dispensed) -> safe to try the NEXT key.
 *   - other 4xx (except 408)    -> definitive rejection (the request reached
 *                                  Circle and was refused) -> do NOT retry,
 *                                  report the error.
 *   - 5xx, 408, transport error -> OUTCOME UNKNOWN: a gateway timeout (502/
 *                                  504), request timeout (408) or a lost
 *                                  connection can all happen AFTER Circle
 *                                  executed the drip. NEVER retried; the
 *                                  caller keeps locks/reservations and tells
 *                                  the user to check their wallet.
 * A shared deadline bounds total wall time inside the serverless function
 * budget (maxDuration 10s), and every attempt carries its own timeout.
 */

import https from 'https';
import { advanceRotation } from './analytics-kv.js';

// Test seam: lets integration tests substitute the HTTPS transport without
// touching the network. Null in production.
let injectedRequester = null;
export function setRequesterForTests(fn) {
  injectedRequester = fn;
}

export const DEFAULT_PER_REQUEST_TIMEOUT_MS = 4000;
export const DEFAULT_TOTAL_DEADLINE_MS = 8500;
export const MAX_ATTEMPTS = 3;
const MAX_RESPONSE_BYTES = 512 * 1024;

const CIRCLE_REQUEST_OPTIONS = Object.freeze({
  hostname: 'api.circle.com',
  port: 443,
  path: '/v1/faucet/drips',
  method: 'POST'
});

/** Exported for tests (the real TLS transport can be exercised against a
 *  local server via the `options` parameter; production always defaults to
 *  the hardcoded Circle endpoint). */
export async function httpsRequester(apiKey, payload, timeoutMs, options = CIRCLE_REQUEST_OPTIONS) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);

    const reqOptions = {
      ...options,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    // Absolute deadline so a black-holed socket can never wedge the handler.
    const timer = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      let bytes = 0;
      let settled = false;

      res.on('data', (chunk) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          settled = true;
          // Destroy WITH an error: a bare destroy() mid-response neither ends
          // nor errors the stream, which would leave the promise unsettled.
          const err = new Error('Response too large');
          err.statusCode = res.statusCode;
          req.destroy(err);
          return;
        }
        data += chunk;
      });

      res.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          settle(resolve, { statusCode: res.statusCode, data: JSON.parse(data) });
        } catch {
          settle(resolve, {
            statusCode: res.statusCode,
            data: { error: 'Invalid JSON response', raw: data.substring(0, 200) }
          });
        }
      });

      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        settle(reject, err);
      });
    });

    req.on('error', (error) => {
      // Promise settle is idempotent; this must run even after an overflow
      // destroy, otherwise the overflow path would never settle.
      settle(reject, error);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Single request to Circle. Resolves {statusCode, data} for any HTTP response;
 * rejects on transport errors and timeouts (ambiguous outcomes).
 * @param {string} apiKey
 * @param {object} payload
 * @param {number} timeoutMs
 * @param {Function} [requester] injectable transport for tests
 * @returns {Promise<{statusCode: number, data: object}>}
 */
export function makeCircleRequest(apiKey, payload, timeoutMs = DEFAULT_PER_REQUEST_TIMEOUT_MS, requester) {
  return (requester || injectedRequester || httpsRequester)(apiKey, payload, timeoutMs);
}

function isAmbiguousStatus(statusCode) {
  return statusCode >= 500 || statusCode === 408;
}

// A Circle attempt with less than this left is abandoned before it starts.
const MIN_ATTEMPT_BUDGET_MS = 1500;

/**
 * Try to complete a drip with at most `maxAttempts` different keys, advancing
 * the shared round-robin rotation for every attempt.
 * @param {object} payload Circle request payload
 * @param {object} opts { keys: string[], requester?, perRequestTimeoutMs?, totalDeadlineMs?, maxAttempts? }
 * @returns {Promise<
 *   | {outcome: 'success', response: object, keyIndex: number}
 *   | {outcome: 'exhausted', lastResponse: object|null, keyIndex: number|null}
 *   | {outcome: 'circle_error', response: object, keyIndex: number}
 *   | {outcome: 'unknown', error?: Error, response?: object, statusCode?: number, keyIndex: number}
 *   | {outcome: 'budget_exhausted', keyIndex: number}  // nothing was sent
 * >}
 */
export async function claimWithFallback(payload, opts) {
  const { keys } = opts;
  const requester = opts.requester || injectedRequester || httpsRequester;
  const perRequestTimeoutMs = opts.perRequestTimeoutMs ?? DEFAULT_PER_REQUEST_TIMEOUT_MS;
  const totalDeadlineMs = opts.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;
  const maxAttempts = Math.min(opts.maxAttempts ?? MAX_ATTEMPTS, keys.length);

  const start = Date.now();
  let lastResponse = null;
  let lastIndex = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // May throw on KV failure. Nothing has been sent to Circle yet, so the
    // caller may safely release reservations in that case.
    const { index } = await advanceRotation(keys.length);

    // Recompute the remaining budget AFTER the rotation INCR: that KV round
    // trip can take up to the KV command deadline, and charging it to the
    // Circle timeout would let per-attempt deadlines overshoot the total
    // (N8). Below MIN_ATTEMPT_BUDGET_MS -> explicitly abandon WITHOUT
    // sending anything (N9): the drips endpoint regularly takes >1s, so a
    // shorter client timeout yields "outcome unknown" on a request that may
    // still have executed server-side — the worst state (24h lock, possible
    // uncredited drip). Matches MIN_CIRCLE_ATTEMPT_MS in api/claim.js.
    const remaining = totalDeadlineMs - (Date.now() - start);
    if (remaining < MIN_ATTEMPT_BUDGET_MS) {
      console.error(
        attempt === 0
          ? '[FALLBACK] Budget exhausted before the first Circle request — nothing was sent'
          : `[FALLBACK] Budget exhausted after ${attempt} Circle attempt(s) — no further request will be sent`
      );
      return { outcome: 'budget_exhausted', keyIndex: index };
    }
    const timeoutMs = Math.min(perRequestTimeoutMs, remaining);

    try {
      console.log(`[FALLBACK] Attempt ${attempt + 1}/${maxAttempts} with key index ${index}`);
      const response = await requester(keys[index], payload, timeoutMs);
      lastIndex = index;

      if (response.statusCode >= 200 && response.statusCode < 300) {
        console.log(`[FALLBACK] Success with key index ${index}`);
        return { outcome: 'success', response, keyIndex: index };
      }

      if (response.statusCode === 429) {
        // Definitive rejection: this key is exhausted. Safe to try the next.
        console.log(`[FALLBACK] Key ${index} rate-limited (429), trying next key...`);
        lastResponse = response;
        continue;
      }

      if (isAmbiguousStatus(response.statusCode)) {
        // 5xx/408: Circle (or its gateway) may have executed the drip before
        // failing. Never retry; the caller must keep the wallet lock.
        console.error(`[FALLBACK] Ambiguous status ${response.statusCode} on key ${index} — treating as unknown`);
        return { outcome: 'unknown', response, statusCode: response.statusCode, keyIndex: index };
      }

      // Definitive 4xx rejection: retrying another key cannot help.
      return { outcome: 'circle_error', response, keyIndex: index };
    } catch (error) {
      // Transport error or timeout: OUTCOME UNKNOWN. The drip may already
      // exist on-chain. Do not retry — report ambiguity upstream.
      console.error(`[FALLBACK] Transport failure on key ${index} (outcome unknown):`, error.message);
      return { outcome: 'unknown', error, keyIndex: index };
    }
  }

  console.error('[FALLBACK] All attempts exhausted');
  return { outcome: 'exhausted', lastResponse, keyIndex: lastIndex };
}
