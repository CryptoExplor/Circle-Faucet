/**
 * Persistent Analytics Module with Vercel KV (Redis)
 * 
 * This replaces the in-memory storage with Vercel KV for true persistence
 * across serverless function instances and cold starts.
 * 
 * Setup Instructions:
 * 1. Install: npm install @vercel/kv
 * 2. Go to vercel.com → Your Project → Storage → Create Database → KV
 * 3. Connect the KV database to your project
 * 4. Environment variables (KV_REST_API_URL, KV_REST_API_TOKEN) are auto-added
 */

import { kv } from '@vercel/kv';

const ANALYTICS_KEY = 'faucet:analytics:v1';
const CURRENT_KEY_INDEX = 'faucet:current_key_index';

// Initialize default analytics structure
const DEFAULT_ANALYTICS = {
  totalClaims: 0,
  successfulClaims: 0,
  failedClaims: 0,
  claimsByNetwork: {},
  claimsByMode: { 'own-key': 0, 'default': 0 },
  keyUsage: {},
  lastReset: Date.now(),
  currentKeyIndex: 0
};

/**
 * Get current analytics data from KV
 * Falls back to default if no data exists
 */
async function getAnalyticsFromKV() {
  try {
    const data = await kv.get(ANALYTICS_KEY);
    if (!data) {
      // Initialize with defaults on first run
      await kv.set(ANALYTICS_KEY, DEFAULT_ANALYTICS);
      return DEFAULT_ANALYTICS;
    }
    return data;
  } catch (error) {
    console.error('[ANALYTICS_KV] Error reading from KV:', error);
    // Return in-memory fallback if KV fails
    if (!global.faucetAnalytics) {
      global.faucetAnalytics = { ...DEFAULT_ANALYTICS };
    }
    return global.faucetAnalytics;
  }
}

/**
 * Save analytics data to KV
 */
async function saveAnalyticsToKV(data) {
  try {
    await kv.set(ANALYTICS_KEY, data);
    console.log('[ANALYTICS_KV] Saved to KV:', {
      totalClaims: data.totalClaims,
      successfulClaims: data.successfulClaims,
      failedClaims: data.failedClaims
    });
  } catch (error) {
    console.error('[ANALYTICS_KV] Error writing to KV:', error);
    // Store in memory as fallback
    global.faucetAnalytics = data;
  }
}

/**
 * Update analytics with a new claim
 * @param {string} mode - 'own-key' or 'default'
 * @param {string} blockchain - Network name
 * @param {boolean} success - Whether claim succeeded
 * @param {number|null} keyIndex - Index of API key used (for default mode)
 */
export async function updateAnalytics(mode, blockchain, success, keyIndex = null) {
  try {
    const stats = await getAnalyticsFromKV();
    
    // Update counters
    stats.totalClaims++;
    
    if (success) {
      stats.successfulClaims++;
    } else {
      stats.failedClaims++;
    }
    
    // Update mode statistics
    stats.claimsByMode[mode] = (stats.claimsByMode[mode] || 0) + 1;
    
    // Update network statistics
    stats.claimsByNetwork[blockchain] = (stats.claimsByNetwork[blockchain] || 0) + 1;
    
    // Update key usage (for default mode with round-robin)
    if (keyIndex !== null) {
      const keyName = `key_${keyIndex}`;
      stats.keyUsage[keyName] = (stats.keyUsage[keyName] || 0) + 1;
    }
    
    // Save back to KV
    await saveAnalyticsToKV(stats);
    
    console.log('[ANALYTICS_KV] Updated:', {
      mode,
      blockchain,
      success,
      keyIndex,
      newTotal: stats.totalClaims
    });
  } catch (error) {
    console.error('[ANALYTICS_KV] Error updating analytics:', error);
  }
}

/**
 * Set the current key index for round-robin rotation
 * @param {number} index - Current key index
 */
export async function setCurrentKeyIndex(index) {
  try {
    await kv.set(CURRENT_KEY_INDEX, index);
    
    // Also update in main analytics object
    const stats = await getAnalyticsFromKV();
    stats.currentKeyIndex = index;
    await saveAnalyticsToKV(stats);
    
    console.log('[ANALYTICS_KV] Set current key index:', index);
  } catch (error) {
    console.error('[ANALYTICS_KV] Error setting key index:', error);
  }
}

/**
 * Get current key index
 * @returns {Promise<number>}
 */
export async function getCurrentKeyIndex() {
  try {
    const index = await kv.get(CURRENT_KEY_INDEX);
    return index || 0;
  } catch (error) {
    console.error('[ANALYTICS_KV] Error getting key index:', error);
    return 0;
  }
}

/**
 * Get analytics data with computed fields
 * @returns {Promise<Object>} Analytics object with uptime and success rate
 */
export async function getAnalytics() {
  try {
    const stats = await getAnalyticsFromKV();
    
    // Calculate uptime
    const uptime = Math.floor((Date.now() - stats.lastReset) / 1000);
    
    // Calculate success rate
    const successRate = stats.totalClaims > 0 
      ? ((stats.successfulClaims / stats.totalClaims) * 100).toFixed(2) + '%'
      : '0%';

    return {
      ...stats,
      uptime,
      successRate
    };
  } catch (error) {
    console.error('[ANALYTICS_KV] Error getting analytics:', error);
    return {
      ...DEFAULT_ANALYTICS,
      uptime: 0,
      successRate: '0%',
      error: 'Failed to fetch analytics from storage'
    };
  }
}

/**
 * Reset analytics (useful for testing or maintenance)
 * @returns {Promise<Object>} New analytics object
 */
export async function resetAnalytics() {
  try {
    const newStats = {
      ...DEFAULT_ANALYTICS,
      lastReset: Date.now()
    };
    await saveAnalyticsToKV(newStats);
    await kv.set(CURRENT_KEY_INDEX, 0);
    console.log('[ANALYTICS_KV] Analytics reset');
    return newStats;
  } catch (error) {
    console.error('[ANALYTICS_KV] Error resetting analytics:', error);
    throw error;
  }
}

/**
 * Get detailed statistics
 * @returns {Promise<Object>} Detailed stats including top networks, etc.
 */
export async function getDetailedStats() {
  try {
    const stats = await getAnalytics();
    
    // Sort networks by claim count
    const topNetworks = Object.entries(stats.claimsByNetwork)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([network, count]) => ({ network, count }));
    
    // Sort keys by usage
    const keyUsageArray = Object.entries(stats.keyUsage)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count }));
    
    return {
      ...stats,
      topNetworks,
      keyUsageArray,
      isBalanced: checkKeyBalance(stats.keyUsage)
    };
  } catch (error) {
    console.error('[ANALYTICS_KV] Error getting detailed stats:', error);
    throw error;
  }
}

/**
 * Check if key usage is balanced (within 20% of average)
 * @param {Object} keyUsage - Key usage object
 * @returns {boolean}
 */
function checkKeyBalance(keyUsage) {
  const values = Object.values(keyUsage);
  if (values.length === 0) return true;
  
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const threshold = avg * 0.2; // 20% tolerance
  
  return values.every(val => Math.abs(val - avg) <= threshold);
}

// Export for backward compatibility
export const analytics = {
  get: getAnalytics,
  update: updateAnalytics,
  reset: resetAnalytics
};
