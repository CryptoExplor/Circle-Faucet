import https from 'https';
import crypto from 'crypto';
import { updateAnalytics, setCurrentKeyIndex } from './lib/analytics.js';

/**
 * RATE LIMITING STRATEGY
 * 
 * BYO API Key Mode:
 * - NO rate limiting from our side
 * - Circle enforces their own limits (5-10 claims/day, varies)
 * 
 * Default Faucet Mode:
 * - Wallet-based: 1 claim per network per 24h
 * - Round-robin key rotation with automatic fallback
 * - Infrastructure DoS protection (100 req/hour per IP)
 */

// Environment variables
const DEFAULT_PASSWORD_HASH = process.env.DEFAULT_PASSWORD_HASH || '';
const CIRCLE_API_KEYS = process.env.CIRCLE_API_KEYS || '';
const FAUCET_DISABLED = process.env.FAUCET_DISABLED === 'true';
const REVOKED_KEY_HASHES = (process.env.REVOKED_API_KEY_HASHES || '').split(',').filter(Boolean);

// Supported chains
const SUPPORTED_CHAINS = {
  'ARC-TESTNET': 'ARC-TESTNET',
  'ETH-SEPOLIA': 'ETH-SEPOLIA',
  'AVAX-FUJI': 'AVAX-FUJI',
  'MATIC-AMOY': 'MATIC-AMOY',
  'SOL-DEVNET': 'SOL-DEVNET',
  'ARB-SEPOLIA': 'ARB-SEPOLIA',
  'UNI-SEPOLIA': 'UNI-SEPOLIA',
  'BASE-SEPOLIA': 'BASE-SEPOLIA',
  'OP-SEPOLIA': 'OP-SEPOLIA',
  'APTOS-TESTNET': 'APTOS-TESTNET'
};

// Round-robin key rotation state (persists across warm starts)
if (!global.currentKeyIndex) {
  global.currentKeyIndex = 0;
}

const getApiKeys = () => {
  if (!CIRCLE_API_KEYS) return [];
  return CIRCLE_API_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0);
};

const getNextApiKey = () => {
  const apiKeys = getApiKeys();
  if (apiKeys.length === 0) return null;
  
  // Get current key
  const key = apiKeys[global.currentKeyIndex];
  
  // Move to next key for next request
  global.currentKeyIndex = (global.currentKeyIndex + 1) % apiKeys.length;
  
  // Update analytics
  setCurrentKeyIndex(global.currentKeyIndex);
  
  console.log(`[KEY_ROTATION] Using key ${global.currentKeyIndex} of ${apiKeys.length}, next will be ${(global.currentKeyIndex + 1) % apiKeys.length}`);
  
  return key;
};

const hashPassword = (password) => {
  return crypto.createHash('sha256').update(password).digest('hex');
};

const validateApiKey = (key) => {
  if (!key || typeof key !== 'string') return false;
  const parts = key.split(':');
  return parts.length === 3 && parts[0] === 'TEST_API_KEY';
};

const hashApiKey = (key) => {
  return crypto.createHash('sha256').update(key).digest('hex');
};

// Rate limiting stores
const requestCountStore = new Map();
const rateLimitStore = new Map();

const checkRateLimit = (identifier, limit, windowMs) => {
  const now = Date.now();
  const windowStart = now - windowMs;
  
  const timestamps = (rateLimitStore.get(identifier) || []).filter(t => t > windowStart);
  rateLimitStore.set(identifier, timestamps);
  
  if (timestamps.length >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: new Date(timestamps[0] + windowMs)
    };
  }
  
  return {
    allowed: true,
    remaining: limit - timestamps.length - 1
  };
};

const recordRateLimit = (identifier) => {
  const timestamps = rateLimitStore.get(identifier) || [];
  timestamps.push(Date.now());
  rateLimitStore.set(identifier, timestamps);
};

const checkInfraLimit = (ip) => {
  const now = Date.now();
  const windowStart = now - (60 * 60 * 1000);
  
  const requests = (requestCountStore.get(ip) || []).filter(t => t > windowStart);
  requestCountStore.set(ip, requests);
  
  if (requests.length >= 100) {
    return { allowed: false, resetTime: new Date(requests[0] + (60 * 60 * 1000)) };
  }
  
  requests.push(now);
  requestCountStore.set(ip, requests);
  return { allowed: true };
};

const auditLog = (event) => {
  console.log('[AUDIT]', JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event
  }));
};

const makeCircleRequest = (apiKey, payload) => {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    
    const options = {
      hostname: 'api.circle.com',
      port: 443,
      path: '/v1/faucet/drips',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            statusCode: res.statusCode,
            data: parsed
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            data: { error: 'Invalid JSON response', raw: data.substring(0, 200) }
          });
        }
      });
    });
    
    req.on('error', (error) => {
      reject(error);
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.write(postData);
    req.end();
  });
};

// Automatic fallback mechanism
const makeCircleRequestWithFallback = async (payload, mode) => {
  const apiKeys = getApiKeys();
  const maxRetries = apiKeys.length;
  let lastError = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const keyIndex = global.currentKeyIndex;
    const apiKey = getNextApiKey();
    
    if (!apiKey) {
      throw new Error('No API keys available');
    }
    
    try {
      console.log(`[FALLBACK] Attempt ${attempt + 1}/${maxRetries} with key index ${keyIndex}`);
      const response = await makeCircleRequest(apiKey, payload);
      
      // If successful, return immediately
      if (response.statusCode >= 200 && response.statusCode < 300) {
        console.log(`[FALLBACK] Success with key index ${keyIndex}`);
        return { response, keyIndex };
      }
      
      // If rate limited (429) or quota exceeded, try next key
      if (response.statusCode === 429 || response.data?.code === 5) {
        console.log(`[FALLBACK] Key ${keyIndex} exhausted (${response.statusCode}), trying next key...`);
        lastError = response;
        continue;
      }
      
      // For other errors, return immediately (don't retry)
      return { response, keyIndex };
      
    } catch (error) {
      console.error(`[FALLBACK] Error with key ${keyIndex}:`, error.message);
      lastError = { statusCode: 500, data: { error: error.message } };
      
      // If it's the last attempt, throw the error
      if (attempt === maxRetries - 1) {
        throw error;
      }
    }
  }
  
  // All keys failed
  console.error('[FALLBACK] All API keys exhausted or failed');
  return { response: lastError || { statusCode: 503, data: { error: 'All API keys exhausted' } }, keyIndex: null };
};

export default async function handler(req, res) {
  const startTime = Date.now();
  let auditData = { mode: null, success: false };
  
  try {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (FAUCET_DISABLED) {
      return res.status(503).json({ 
        error: 'Faucet temporarily disabled',
        message: 'The faucet is currently under maintenance. Please try again later.'
      });
    }

    // Get client IP
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.headers['x-real-ip'] || 
                     'unknown';
    
    // Infrastructure DoS protection
    const infraCheck = checkInfraLimit(clientIp);
    if (!infraCheck.allowed) {
      auditLog({
        event: 'infra_limit_exceeded',
        ip: crypto.createHash('sha256').update(clientIp).digest('hex').substring(0, 16),
      });
      
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Infrastructure rate limit exceeded (100 req/hour). Please try again later.',
        resetTime: infraCheck.resetTime
      });
    }

    // Parse and validate request body
    let { address, blockchain, native, usdc, eurc, apiKey, password, mode } = req.body || {};

    // Log request (without sensitive data)
    console.log('[REQUEST]', { 
      address: address?.substring(0, 10) + '...', 
      blockchain, 
      mode,
      tokens: { native, usdc, eurc }
    });

    // Remove sensitive data from logging
    if (apiKey) {
      const keyHash = hashApiKey(apiKey);
      auditData.apiKeyHash = keyHash.substring(0, 16);
    }

    // Basic validation
    if (!address || !blockchain) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Address and blockchain are required'
      });
    }

    if (!SUPPORTED_CHAINS[blockchain]) {
      return res.status(400).json({
        error: 'Unsupported blockchain',
        message: `Blockchain "${blockchain}" is not supported`,
        supported: Object.keys(SUPPORTED_CHAINS)
      });
    }

    if (!native && !usdc && !eurc) {
      return res.status(400).json({ 
        error: 'No tokens selected',
        message: 'Please select at least one token to claim'
      });
    }

    auditData = {
      ...auditData,
      mode,
      blockchain,
      tokens: { native, usdc, eurc },
      walletHash: crypto.createHash('sha256').update(address).digest('hex').substring(0, 16),
      ipHash: crypto.createHash('sha256').update(clientIp).digest('hex').substring(0, 16)
    };

    let circleApiKey = '';
    let usesFallback = false;
    let usedKeyIndex = null;

    // MODE 1: User's own API key
    if (mode === 'own-key') {
      if (!apiKey) {
        return res.status(400).json({ 
          error: 'API key required',
          message: 'Please provide your Circle API key'
        });
      }

      if (!validateApiKey(apiKey)) {
        auditLog({ ...auditData, event: 'invalid_api_key_format' });
        return res.status(400).json({ 
          error: 'Invalid API key',
          message: 'API key format is invalid. Expected: TEST_API_KEY:xxx:xxx'
        });
      }

      const keyHash = hashApiKey(apiKey);
      
      if (REVOKED_KEY_HASHES.includes(keyHash)) {
        auditLog({ ...auditData, event: 'revoked_key_attempt' });
        return res.status(403).json({
          error: 'API key revoked',
          message: 'This API key has been revoked. Please contact support.'
        });
      }

      circleApiKey = apiKey;
    } 
    // MODE 2: Default faucet
    else if (mode === 'default') {
      if (!password) {
        return res.status(400).json({ 
          error: 'Password required',
          message: 'Please provide the faucet password'
        });
      }

      const inputHash = hashPassword(password);
      if (inputHash !== DEFAULT_PASSWORD_HASH) {
        auditLog({ ...auditData, event: 'invalid_password', ip: auditData.ipHash });
        return res.status(401).json({ 
          error: 'Invalid password',
          message: 'The password you entered is incorrect'
        });
      }

      const apiKeys = getApiKeys();
      if (apiKeys.length === 0) {
        console.error('[ERROR] No Circle API keys configured');
        return res.status(503).json({ 
          error: 'No API keys configured',
          message: 'Default faucet is not available. Please use your own API key.'
        });
      }

      // Wallet-based rate limit
      const walletHash = crypto.createHash('sha256').update(address + blockchain).digest('hex');
      const walletLimit = checkRateLimit(`wallet:${walletHash}`, 1, 24 * 60 * 60 * 1000);
      
      if (!walletLimit.allowed) {
        auditLog({ ...auditData, event: 'wallet_limit_exceeded' });
        return res.status(429).json({
          error: 'Wallet rate limit exceeded',
          message: 'This wallet already claimed tokens on this network in the last 24 hours',
          resetTime: walletLimit.resetTime
        });
      }
      
      recordRateLimit(`wallet:${walletHash}`);
      usesFallback = true;
    } else {
      return res.status(400).json({ 
        error: 'Invalid mode',
        message: 'Please select a valid claim mode (own-key or default)'
      });
    }

    // Build Circle API payload
    const payload = {
      address: address,
      blockchain: SUPPORTED_CHAINS[blockchain]
    };

    if (native) payload.native = true;
    if (usdc) payload.usdc = true;
    if (eurc) payload.eurc = true;

    console.log('[CIRCLE_REQUEST]', { blockchain: payload.blockchain, tokens: { native, usdc, eurc } });

    // Make request to Circle API (with fallback for default mode)
    let circleResponse;
    
    if (usesFallback) {
      const result = await makeCircleRequestWithFallback(payload, mode);
      circleResponse = result.response;
      usedKeyIndex = result.keyIndex;
    } else {
      circleResponse = await makeCircleRequest(circleApiKey, payload);
    }

    console.log('[CIRCLE_RESPONSE]', { statusCode: circleResponse.statusCode });

    // Handle successful claim
    if (circleResponse.statusCode >= 200 && circleResponse.statusCode < 300) {
      auditData.success = true;
      auditData.duration = Date.now() - startTime;
      auditLog({ ...auditData, event: 'claim_success', keyIndex: usedKeyIndex });
      
      // Update analytics
      updateAnalytics(mode, blockchain, true, usedKeyIndex);
      
      return res.status(200).json({
        success: true,
        message: 'Tokens claimed successfully',
        transactionId: circleResponse.data.transactionId || circleResponse.data.id,
        data: circleResponse.data
      });
    }

    // Update analytics for failed claim
    updateAnalytics(mode, blockchain, false, usedKeyIndex);

    // Handle Circle API errors
    auditLog({ 
      ...auditData, 
      event: 'circle_api_error',
      statusCode: circleResponse.statusCode,
      error: circleResponse.data.message,
      keyIndex: usedKeyIndex
    });
    
    return res.status(circleResponse.statusCode).json({
      error: 'Circle API error',
      message: circleResponse.data.message || 'Failed to claim tokens',
      code: circleResponse.data.code,
      details: circleResponse.data
    });

  } catch (error) {
    console.error('[FATAL_ERROR]', error);
    auditLog({ 
      ...auditData, 
      event: 'internal_error',
      error: error.message,
      stack: error.stack
    });
    
    // Update analytics for error
    if (auditData.mode && auditData.blockchain) {
      updateAnalytics(auditData.mode, auditData.blockchain, false);
    }
    
    return res.status(500).json({ 
      error: 'Internal server error',
      message: 'An unexpected error occurred. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
