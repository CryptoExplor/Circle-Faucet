/**
 * GET /api/stats — analytics endpoint.
 *
 * Reads are composed from atomic KV counters (see lib/analytics-kv.js).
 * A small per-instance cache (STATS_CACHE_MS, default 5s) keeps dashboard
 * auto-refresh from multiplying KV read commands — a deliberate trade of a
 * few seconds of staleness for a 10-100x cut in metered Redis reads.
 *
 * `keyUsage`, `currentKeyIndex` and `availableKeys` describe the shared API
 * key pool and are mild reconnaissance info for an attacker. Set
 * ADMIN_STATS_TOKEN in the environment to require an `x-admin-token` header
 * for those fields (the public dashboard will then show zeros for them).
 */

import { getAnalytics } from './lib/analytics-kv.js';
import { safeEqual } from './lib/validate.js';

const configError = 'Ensure Vercel KV is properly configured in your project settings.';
const CACHE_MS_DEFAULT = 5000;

let cache = { at: 0, value: null };

async function getAnalyticsCached(availableKeys) {
  const ttl = parseInt(process.env.STATS_CACHE_MS, 10);
  const cacheMs = Number.isInteger(ttl) && ttl >= 0 ? ttl : CACHE_MS_DEFAULT;
  if (cacheMs > 0 && cache.value && Date.now() - cache.at < cacheMs) {
    return cache.value;
  }
  const value = await getAnalytics(availableKeys);
  cache = { at: Date.now(), value };
  return value;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiKeys = (process.env.CIRCLE_API_KEYS || '')
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
    const availableKeys = apiKeys.length;

    const analytics = await getAnalyticsCached(availableKeys);

    let { keyUsage, currentKeyIndex } = analytics;
    const adminToken = process.env.ADMIN_STATS_TOKEN;
    const isAdmin = adminToken
      ? safeEqual(req.headers['x-admin-token'] || '', adminToken)
      : true;

    let visibleAvailableKeys = availableKeys;
    if (!isAdmin) {
      keyUsage = {};
      currentKeyIndex = 0;
      visibleAvailableKeys = 0;
    }

    console.log('[STATS] Returning analytics:', {
      totalClaims: analytics.totalClaims,
      successfulClaims: analytics.successfulClaims,
      failedClaims: analytics.failedClaims,
      successRate: analytics.successRate
    });

    // Honest storage signal: if the composed snapshot carries an error the
    // reader fell back to defaults because KV is unreachable/misconfigured.
    const kvConfigured = analytics.error === undefined;

    return res.status(200).json({
      totalClaims: analytics.totalClaims,
      successfulClaims: analytics.successfulClaims,
      failedClaims: analytics.failedClaims,
      claimsByNetwork: analytics.claimsByNetwork,
      claimsByMode: analytics.claimsByMode,
      keyUsage,
      lastReset: analytics.lastReset,
      currentKeyIndex,
      uptime: analytics.uptime,
      successRate: analytics.successRate,
      availableKeys: visibleAvailableKeys,
      timestamp: new Date().toISOString(),
      storageType: kvConfigured ? 'vercel-kv' : 'unavailable',
      ...(analytics.error ? { warning: analytics.error } : {})
    });
  } catch (error) {
    console.error('[STATS_ERROR]', error);
    return res.status(500).json({
      error: 'Failed to fetch analytics',
      message: error.message,
      details: configError
    });
  }
}
