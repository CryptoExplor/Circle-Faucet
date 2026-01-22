import { getAnalytics } from './lib/analytics.js';

/**
 * Analytics Statistics Endpoint
 * GET /api/stats
 * 
 * Returns real-time faucet usage statistics
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
    const analytics = getAnalytics();

    // Get API keys count from environment
    const CIRCLE_API_KEYS = process.env.CIRCLE_API_KEYS || '';
    const apiKeys = CIRCLE_API_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0);

    return res.status(200).json({
      ...analytics,
      availableKeys: apiKeys.length,
      timestamp: new Date().toISOString(),
      note: 'Analytics data persists during warm function lifecycle but resets on cold starts. For persistent analytics, integrate a database like Vercel KV.'
    });
  } catch (error) {
    console.error('[STATS_ERROR]', error);
    return res.status(500).json({ 
      error: 'Failed to fetch analytics',
      message: error.message 
    });
  }
}
