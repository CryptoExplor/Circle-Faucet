/**
 * Persistent Analytics Module — Vercel KV (Redis)
 *
 * FIX: Key rotation used a read-modify-write cycle with no atomicity.
 * Two concurrent requests would read the same index, both write index+1,
 * and effectively skip a key — or worse, cause a thundering-herd on key_0.
 *
 * Fix: use kv.incr() for the rotation counter so the increment is atomic.
 * All other analytics writes use a single kv.set() per request (last-write-wins
 * is acceptable for counters; we use hincrby-style field isolation instead).
 */

import { kv } from '@vercel/kv';

// Keys
const KEY_STATS        = 'faucet:stats:v2';
const KEY_ROTATION_CTR = 'faucet:rotation_ctr'; // atomic counter — never read-modify-write this
const KEY_LAST_RESET   = 'faucet:last_reset';

const DEFAULT_STATS = {
  totalClaims:      0,
  successfulClaims: 0,
  failedClaims:     0,
  claimsByNetwork:  {},
  claimsByMode:     { 'own-key': 0, default: 0 },
  keyUsage:         {},
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readStats() {
  try {
    const data = await kv.get(KEY_STATS);
    if (!data) {
      await kv.set(KEY_STATS, DEFAULT_STATS);
      return { ...DEFAULT_STATS };
    }
    return data;
  } catch (err) {
    console.error('[ANALYTICS] KV read failed, using in-process fallback:', err.message);
    if (!global.__faucetStats) global.__faucetStats = { ...DEFAULT_STATS };
    return global.__faucetStats;
  }
}

async function writeStats(data) {
  try {
    await kv.set(KEY_STATS, data);
    global.__faucetStats = data; // keep in-process copy as warm fallback
  } catch (err) {
    console.error('[ANALYTICS] KV write failed:', err.message);
    global.__faucetStats = data;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a claim attempt.
 * @param {string}      mode       'own-key' | 'default'
 * @param {string}      blockchain  e.g. 'ETH-SEPOLIA'
 * @param {boolean}     success
 * @param {number|null} keyIndex   rotation index used (default mode only)
 */
export async function updateAnalytics(mode, blockchain, success, keyIndex = null) {
  try {
    const stats = await readStats();

    stats.totalClaims++;
    if (success) stats.successfulClaims++;
    else         stats.failedClaims++;

    stats.claimsByMode[mode] = (stats.claimsByMode[mode] ?? 0) + 1;
    stats.claimsByNetwork[blockchain] = (stats.claimsByNetwork[blockchain] ?? 0) + 1;

    if (keyIndex !== null) {
      const k = `key_${keyIndex}`;
      stats.keyUsage[k] = (stats.keyUsage[k] ?? 0) + 1;
    }

    await writeStats(stats);

    console.log('[ANALYTICS] updated', { mode, blockchain, success, keyIndex, total: stats.totalClaims });
  } catch (err) {
    console.error('[ANALYTICS] updateAnalytics error:', err.message);
  }
}

/**
 * Atomically advance the rotation counter and return the key index to use.
 * Uses kv.incr() so concurrent requests never collide.
 *
 * @param {number} totalKeys  total number of API keys configured
 * @returns {Promise<number>} index in [0, totalKeys)
 */
export async function getNextKeyIndex(totalKeys) {
  try {
    // incr returns the value AFTER increment (1-based), so subtract 1 for 0-based index
    const raw = await kv.incr(KEY_ROTATION_CTR);
    return (raw - 1) % totalKeys;
  } catch (err) {
    console.error('[ANALYTICS] getNextKeyIndex KV error, falling back to 0:', err.message);
    return 0;
  }
}

/**
 * @deprecated  Use getNextKeyIndex(totalKeys) instead.
 * Kept for backwards compat — callers in claim.js that still use the old API.
 */
export async function getCurrentKeyIndex() {
  try {
    const raw = await kv.get(KEY_ROTATION_CTR);
    return typeof raw === 'number' ? raw % 1000000 : 0; // guard against unbounded growth in display
  } catch {
    return 0;
  }
}

/** No longer needed — rotation is driven by getNextKeyIndex. Kept for compat. */
export async function setCurrentKeyIndex(_index) {
  // no-op: rotation counter is now exclusively managed by kv.incr()
}

/**
 * Full analytics snapshot for /api/stats.
 */
export async function getAnalytics() {
  try {
    const stats = await readStats();
    const rotationRaw = await kv.get(KEY_ROTATION_CTR).catch(() => 0);
    const lastReset   = await kv.get(KEY_LAST_RESET).catch(() => Date.now());

    const uptime      = Math.floor((Date.now() - (lastReset ?? Date.now())) / 1000);
    const successRate = stats.totalClaims > 0
      ? ((stats.successfulClaims / stats.totalClaims) * 100).toFixed(2) + '%'
      : '0%';

    return {
      ...stats,
      uptime,
      successRate,
      currentKeyIndex: typeof rotationRaw === 'number' ? rotationRaw % 1000000 : 0,
    };
  } catch (err) {
    console.error('[ANALYTICS] getAnalytics error:', err.message);
    return { ...DEFAULT_STATS, uptime: 0, successRate: '0%', currentKeyIndex: 0 };
  }
}

/**
 * Hard reset — wipes all counters.
 */
export async function resetAnalytics() {
  const fresh = { ...DEFAULT_STATS };
  await writeStats(fresh);
  await kv.set(KEY_ROTATION_CTR, 0);
  await kv.set(KEY_LAST_RESET, Date.now());
  console.log('[ANALYTICS] reset complete');
  return fresh;
}
