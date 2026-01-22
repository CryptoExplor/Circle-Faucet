/**
 * Shared Analytics Module
 * 
 * Note: Vercel serverless functions are stateless.
 * This in-memory store will reset on cold starts.
 * 
 * For production with persistent analytics, consider:
 * - Vercel KV (Redis)
 * - Upstash Redis
 * - Vercel Postgres
 * - External analytics service
 */

// Global analytics store
// This persists across warm function invocations but resets on cold starts
if (!global.faucetAnalytics) {
  global.faucetAnalytics = {
    totalClaims: 0,
    successfulClaims: 0,
    failedClaims: 0,
    claimsByNetwork: {},
    claimsByMode: { 'own-key': 0, 'default': 0 },
    keyUsage: {},
    lastReset: Date.now(),
    currentKeyIndex: 0
  };
}

export const analytics = global.faucetAnalytics;

export function updateAnalytics(mode, blockchain, success, keyIndex = null) {
  analytics.totalClaims++;
  
  if (success) {
    analytics.successfulClaims++;
  } else {
    analytics.failedClaims++;
  }
  
  analytics.claimsByMode[mode] = (analytics.claimsByMode[mode] || 0) + 1;
  analytics.claimsByNetwork[blockchain] = (analytics.claimsByNetwork[blockchain] || 0) + 1;
  
  if (keyIndex !== null) {
    analytics.keyUsage[`key_${keyIndex}`] = (analytics.keyUsage[`key_${keyIndex}`] || 0) + 1;
  }
}

export function setCurrentKeyIndex(index) {
  analytics.currentKeyIndex = index;
}

export function getAnalytics() {
  const uptime = Math.floor((Date.now() - analytics.lastReset) / 1000);
  const successRate = analytics.totalClaims > 0 
    ? ((analytics.successfulClaims / analytics.totalClaims) * 100).toFixed(2) + '%'
    : '0%';

  return {
    ...analytics,
    uptime,
    successRate
  };
}
