/**
 * Circle faucet API client (<code>POST /v1/faucet/drips</code>) with bounded,
 * ambiguity-safe fallback across the configured API keys.
 *
 * Retry semantics (v2.1.1) — a faucet drip is a NON-IDEMPOTENT POST:
 *   - 2xx                    -> definitive success, stop.
 *   - 429                    -> definitive rejection by Circle, the key is
 *                               exhausted -> safe to try the NEXT key.
 *   - any other HTTP status  -> definitive rejection, do NOT retry (the same
 *                               payload will fail identically on other keys).
 *   - transport error / timeout -> OUTCOME UNKNOWN: the drip may or may not
 *                               have been issued. NEVER retry (double-drip
 *                               risk) — surface an "unknown outcome" result
 *                               instead.
 * A shared deadline bounds total wall time inside the serverless function
 * budget (maxDuration 10s), so a hanging connection cannot consume the whole
 * allowance on one key.
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

/**
 * Try to complete a drip with at most `maxAttempts` different keys, advancing
 * the shared round-robin rotation for every attempt.
 * @param {object} payload Circle request payload
 * @param {object} opts { keys: string[], requester?, perRequestTimeoutMs?, totalDeadlineMs?, maxAttempts? }
 * @returns {Promise<
 *   | {outcome: 'success', response: object, keyIndex: number}
 *   | {outcome: 'exhausted', lastResponse: object|null, keyIndex: number|null}
 *   | {outcome: 'circle_error', response: object, keyIndex: number}
 *   | {outcome: 'unknown', error: Error, keyIndex: number}
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
    const remaining = totalDeadlineMs - (Date.now() - start);
    // The FIRST attempt always runs (an over-tight deadline must never turn
    // into an instant "exhausted"); retries need real budget left.
    if (attempt > 0 && remaining < 500) break;

    const { index } = await advanceRotation(keys.length);
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

      // Definitive non-429 error: retrying another key cannot help.
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

function httpsRequester(apiKey, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);

    const options = {
      hostname: 'api.circle.com',
      port: 443,
      path: '/v1/faucet/drips',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      let bytes = 0;
      let overflow = false;

      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          overflow = true;
          req.destroy();
          return;
        }
        data += chunk;
      });

      res.on('end', () => {
        if (overflow) {
          resolve({
            statusCode: res.statusCode,
            data: { error: 'Response too large' }
          });
          return;
        }
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({
            statusCode: res.statusCode,
            data: { error: 'Invalid JSON response', raw: data.substring(0, 200) }
          });
        }
      });
    });

    req.on('error', reject);

    // Absolute deadline (socket-level idle timeout is not sufficient).
    const timer = setTimeout(() => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    req.write(postData);
    req.end();
  });
}
