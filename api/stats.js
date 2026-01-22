import { getAnalytics } from './lib/analytics-kv.js';

/**
 * Analytics Statistics Endpoint
 * GET /api/stats
 * 
 * Returns real-time faucet usage statistics from Vercel KV
 */

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get analytics from KV
    const analytics = await getAnalytics();

    // Get API keys count from environment
    const CIRCLE_API_KEYS = process.env.CIRCLE_API_KEYS || '';
    const apiKeys = CIRCLE_API_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0);

    console.log('[STATS] Returning analytics:', {
      totalClaims: analytics.totalClaims,
      successfulClaims: analytics.successfulClaims,
      failedClaims: analytics.failedClaims,
      successRate: analytics.successRate
    });

    return res.status(200).json({
      ...analytics,
      availableKeys: apiKeys.length,
      timestamp: new Date().toISOString(),
      storageType: 'vercel-kv',
      note: 'Analytics data is now persisted in Vercel KV and survives cold starts and serverless restarts.'
    });
  } catch (error) {
    console.error('[STATS_ERROR]', error);
    return res.status(500).json({ 
      error: 'Failed to fetch analytics',
      message: error.message,
      details: 'Ensure Vercel KV is properly configured in your project settings.'
    });
  }
}
