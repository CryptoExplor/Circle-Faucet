/**
 * Persistent Analytics Module — Vercel KV (Redis)
 *
 * FIX (original): Key rotation used a read-modify-write cycle with no atomicity.
 * Fixed by using kv.incr() for the rotation counter.
 *
 * FIX (v2 migration): Renamed KV key from faucet:analytics:v1 → faucet:stats:v2.
 * readStats() now checks v1 on first run and migrates the data forward automatically.
 */

import { kv } from '@vercel/kv';

// Keys
const KEY_STATS        = 'faucet:stats:v2';
const KEY_STATS_V1     = 'faucet:analytics:v1'; // legacy — read once for migration only
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

    if (data) return data;

    // v2 key is empty — check whether old v1 data exists and migrate it once.
    const legacy = await kv.get(KEY_STATS_V1).catch(() => null);
    if (legacy && typeof legacy === 'object') {
      const migrated = {
        ...DEFAULT_STATS,
        ...legacy,
        claimsByMode:    { 'own-key': 0, default: 0, ...(legacy.claimsByMode ?? {}) },
        claimsByNetwork: legacy.claimsByNetwork ?? {},
        keyUsage:        legacy.keyUsage ?? {},
      };
      await kv.set(KEY_STATS, migrated);
      console.log('[ANALYTICS] migrated v1 -> v2, totalClaims:', migrated.totalClaims);
      return migrated;
    }

    // Genuinely fresh install
    await kv.set(KEY_STATS, DEFAULT_STATS);
    return { ...DEFAULT_STATS };
  } catch (err) {
    console.error('[ANALYTICS] KV read failed, using in-process fallback:', err.message);
    if (!global.__faucetStats) global.__faucetStats = { ...DEFAULT_STATS };
    return global.__faucetStats;
  }
}

async function writeStats(data) {
  try {
    await kv.set(KEY_STATS, data);
    global.__faucetStats = data;
  } catch (err) {
    console.error('[ANALYTICS] KV write failed:', err.message);
    global.__faucetStats = data;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
 * kv.incr() is atomic — concurrent requests never collide.
 */
export async function getNextKeyIndex(totalKeys) {
  try {
    const raw = await kv.incr(KEY_ROTATION_CTR);
    return (raw - 1) % totalKeys;
  } catch (err) {
    console.error('[ANALYTICS] getNextKeyIndex KV error, falling back to 0:', err.message);
    return 0;
  }
}

/** @deprecated Use getNextKeyIndex(totalKeys). Kept for backwards compat. */
export async function getCurrentKeyIndex() {
  try {
    const raw = await kv.get(KEY_ROTATION_CTR);
    return typeof raw === 'number' ? raw % 1_000_000 : 0;
  } catch {
    return 0;
  }
}

/** @deprecated No-op. Rotation counter is managed by kv.incr() only. */
export async function setCurrentKeyIndex(_index) {}

export async function getAnalytics() {
  try {
    const stats      = await readStats();
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
      currentKeyIndex: typeof rotationRaw === 'number' ? rotationRaw % 1_000_000 : 0,
    };
  } catch (err) {
    console.error('[ANALYTICS] getAnalytics error:', err.message);
    return { ...DEFAULT_STATS, uptime: 0, successRate: '0%', currentKeyIndex: 0 };
  }
}

export async function resetAnalytics() {
  const fresh = { ...DEFAULT_STATS };
  await writeStats(fresh);
  await kv.set(KEY_ROTATION_CTR, 0);
  await kv.set(KEY_LAST_RESET, Date.now());
  console.log('[ANALYTICS] reset complete');
  return fresh;
}
