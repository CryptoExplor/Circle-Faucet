/**
 * Persistent Analytics + key rotation — Vercel KV (Redis), ATOMIC ONLY.
 *
 * v2.1.1 rewrite: the previous implementation read one JSON document, mutated
 * it in JS and wrote it back. Under concurrent serverless invocations that is
 * a classic lost-update race (measured: 19 of 20 concurrent claims lost). All
 * counters are now single atomic commands (INCR / HINCRBY) so no read-back is
 * ever needed and no update can be lost, regardless of concurrency.
 *
 * Counter keys:
 *   faucet:stats:total        INCR  total claims attempted
 *   faucet:stats:success      INCR  confirmed successes
 *   faucet:stats:failed       INCR  failures / unknown outcomes
 *   faucet:stats:mode         HINCRBY (own-key | default | unknown)
 *   faucet:stats:network      HINCRBY (validated chain ids only)
 *   faucet:stats:keys         HINCRBY (key_<index>)
 *   faucet:stats:lastReset    string timestamp
 *   faucet:key_rotation       INCR  — monotonic rotation counter; the key used
 *                                     for a claim is (n-1) % keyCount
 */

import { getKv } from './kv.js';

const TOTAL_KEY = 'faucet:stats:total';
const SUCCESS_KEY = 'faucet:stats:success';
const FAILED_KEY = 'faucet:stats:failed';
const MODE_KEY = 'faucet:stats:mode';
const NETWORK_KEY = 'faucet:stats:network';
const KEYS_HASH = 'faucet:stats:keys';
const LAST_RESET_KEY = 'faucet:stats:lastReset';
const ROTATION_KEY = 'faucet:key_rotation';

const VALID_MODES = new Set(['own-key', 'default']);
const FIELD_SANITIZER = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Record one claim attempt using only atomic increments. Never throws —
 * analytics must not take a claim response down with it.
 * @param {string} mode 'own-key' | 'default' (anything else counted as 'unknown')
 * @param {string} blockchain validated chain id (sanitized again here)
 * @param {boolean} success
 * @param {number|null} keyIndex index of the API key used (default mode)
 */
export async function updateAnalytics(mode, blockchain, success, keyIndex = null) {
  try {
    const kv = await getKv();
    const modeField = VALID_MODES.has(mode) ? mode : 'unknown';
    const networkField = FIELD_SANITIZER.test(blockchain) ? blockchain : 'invalid';

    await kv.incr(TOTAL_KEY);
    await kv.incr(success ? SUCCESS_KEY : FAILED_KEY);
    await kv.hincrby(MODE_KEY, modeField, 1);
    await kv.hincrby(NETWORK_KEY, networkField, 1);
    if (keyIndex !== null && Number.isInteger(keyIndex) && keyIndex >= 0 && keyIndex < 1000) {
      await kv.hincrby(KEYS_HASH, `key_${keyIndex}`, 1);
    }
    // lastReset is created once; resetAnalytics() refreshes it.
    await kv.set(LAST_RESET_KEY, String(getAnalyticsEpoch()), { nx: true });

    console.log('[ANALYTICS_KV] Updated:', { mode: modeField, blockchain: networkField, success, keyIndex });
  } catch (error) {
    console.error('[ANALYTICS_KV] Error updating analytics:', error.message);
  }
}

/**
 * Atomically advance the round-robin rotation and return the index to use.
 * Safe under concurrency: INCR is a single Redis command, so two concurrent
 * claims always get different indices, and changing the number of configured
 * keys can never produce an out-of-range index (we always mod by the CURRENT
 * key count).
 * @param {number} keyCount number of configured API keys (> 0)
 * @returns {Promise<{index: number, counter: number}>}
 */
export async function advanceRotation(keyCount) {
  if (!Number.isInteger(keyCount) || keyCount <= 0) {
    throw new Error('advanceRotation requires a positive key count');
  }
  const kv = await getKv();
  const counter = await kv.incr(ROTATION_KEY);
  const index = (counter - 1) % keyCount;
  console.log(`[KEY_ROTATION] counter=${counter} using key ${index} of ${keyCount}`);
  return { index, counter };
}

/**
 * Index of the most recently used key (for the dashboard).
 * @param {number} keyCount
 * @returns {Promise<number>}
 */
export async function getCurrentKeyIndex(keyCount) {
  try {
    const kv = await getKv();
    const counter = await kv.get(ROTATION_KEY);
    const n = parseInt(counter, 10);
    if (!Number.isFinite(n) || n <= 0 || !keyCount) return 0;
    return (n - 1) % keyCount;
  } catch (error) {
    console.error('[ANALYTICS_KV] Error reading rotation counter:', error.message);
    return 0;
  }
}

function getAnalyticsEpoch() {
  return Date.now();
}

/**
 * Compose the analytics document. Reads are eventually consistent with
 * writes (Redis is strongly consistent per command; the composition is a
 * snapshot, which is fine for a dashboard).
 * @param {number|null} keyCount configured key count, for currentKeyIndex
 * @returns {Promise<object>}
 */
export async function getAnalytics(keyCount = null) {
  try {
    const kv = await getKv();
    const [total, success, failed, byMode, byNetwork, keyUsage, lastResetRaw] = await Promise.all([
      kv.get(TOTAL_KEY),
      kv.get(SUCCESS_KEY),
      kv.get(FAILED_KEY),
      kv.hgetall(MODE_KEY),
      kv.hgetall(NETWORK_KEY),
      kv.hgetall(KEYS_HASH),
      kv.get(LAST_RESET_KEY)
    ]);

    const totalClaims = toInt(total);
    const successfulClaims = toInt(success);
    const failedClaims = toInt(failed);
    const lastReset = toInt(lastResetRaw) || getAnalyticsEpoch();
    const uptime = Math.max(0, Math.floor((Date.now() - lastReset) / 1000));
    const successRate =
      totalClaims > 0 ? ((successfulClaims / totalClaims) * 100).toFixed(2) + '%' : '0%';

    return {
      totalClaims,
      successfulClaims,
      failedClaims,
      claimsByMode: toIntObject(byMode),
      claimsByNetwork: toIntObject(byNetwork),
      keyUsage: toIntObject(keyUsage),
      lastReset,
      currentKeyIndex: await getCurrentKeyIndex(keyCount || 0),
      uptime,
      successRate
    };
  } catch (error) {
    console.error('[ANALYTICS_KV] Error reading analytics:', error.message);
    return {
      ...emptyStats(),
      error: 'Failed to fetch analytics from storage'
    };
  }
}

export async function getDetailedStats(keyCount = null) {
  const stats = await getAnalytics(keyCount);
  const topNetworks = Object.entries(stats.claimsByNetwork)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([network, count]) => ({ network, count }));
  const keyUsageArray = Object.entries(stats.keyUsage).sort((a, b) => b[1] - a[1]);
  return { ...stats, topNetworks, keyUsageArray };
}

/**
 * Reset all analytics counters (maintenance operation).
 */
export async function resetAnalytics() {
  const kv = await getKv();
  await kv.del(TOTAL_KEY, SUCCESS_KEY, FAILED_KEY, MODE_KEY, NETWORK_KEY, KEYS_HASH, ROTATION_KEY);
  await kv.set(LAST_RESET_KEY, String(getAnalyticsEpoch()));
  console.log('[ANALYTICS_KV] Analytics reset');
  return getAnalytics();
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toIntObject(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toInt(v);
  return out;
}

function emptyStats() {
  return {
    totalClaims: 0,
    successfulClaims: 0,
    failedClaims: 0,
    claimsByMode: { 'own-key': 0, default: 0 },
    claimsByNetwork: {},
    keyUsage: {},
    lastReset: getAnalyticsEpoch(),
    currentKeyIndex: 0,
    uptime: 0,
    successRate: '0%'
  };
}

// Backwards-compatible named export shape used elsewhere in the repo.
export const analytics = {
  get: getAnalytics,
  update: updateAnalytics,
  reset: resetAnalytics
};
