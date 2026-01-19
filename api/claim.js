import https from 'https';
import crypto from 'crypto';

/**
 * THREAT MODEL & TRUST BOUNDARIES
 * 
 * BYO API Key Mode:
 * - User owns their Circle quota → we don't enforce token limits
 * - Server only protects: infrastructure, abuse optics, DoS
 * - Let Circle enforce their own rate limits (varies: 5-10 claims/day)
 * 
 * Default Faucet Mode:
 * - We own the quota → STRICT enforcement required
 * - Multiple layers: password, rate limits, audit logs
 * 
 * What We Protect Against:
 * - DoS / spam against our Vercel functions
 * - Circle flagging our domain for abuse
 * - Password brute force against default mode
 * - Accidental API key exposure in logs/errors
 */

// Environment variables
const DEFAULT_PASSWORD_HASH = process.env.DEFAULT_PASSWORD_HASH || '';
const CIRCLE_API_KEYS = process.env.CIRCLE_API_KEYS || '';
const FAUCET_DISABLED = process.env.FAUCET_DISABLED === 'true';
const REVOKED_KEY_HASHES = (process.env.REVOKED_API_KEY_HASHES || '').split(',').filter(Boolean);

// Supported chains (strict validation)
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

// Parse multiple API keys for default faucet
const getApiKeys = () => {
  if (!CIRCLE_API_KEYS) return [];
  return CIRCLE_API_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 0);
};

// Secure password hashing
const hashPassword = (password) => {
  return crypto.createHash('sha256').update(password + 'SALT_HERE').digest('hex');
};

// Validate API key format
const validateApiKey = (key) => {
  if (!key || typeof key !== 'string') return false;
  const parts = key.split(':');
  return parts.length === 3 && parts[0] === 'TEST_API_KEY';
};

// Hash for revocation
const hashApiKey = (key) => {
  return crypto.createHash('sha256').update(key).digest('hex');
};

// Simple in-memory rate limiter
// WARNING: This resets on deploy. Use Vercel KV/Redis for production.
const rateLimitStore = new Map();
const requestCountStore = new Map(); // Infrastructure DoS protection

const checkRateLimit = (identifier, limit, windowMs) => {
  const now = Date.now();
  const windowStart = now - windowMs;
  
  // Clean expired entries
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

// Infrastructure DoS protection (applies to ALL requests)
const checkInfraLimit = (ip) => {
  const now = Date.now();
  const windowStart = now - (60 * 60 * 1000); // 1 hour
  
  const requests = (requestCountStore.get(ip) || []).filter(t => t > windowStart);
  requestCountStore.set(ip, requests);
  
  // 100 requests per hour per IP (infrastructure protection)
  if (requests.length >= 100) {
    return { allowed: false, resetTime: new Date(requests[0] + (60 * 60 * 1000)) };
  }
  
  requests.push(now);
  requestCountStore.set(ip, requests);
  return { allowed: true };
};

// Audit logging (write-only, for abuse detection)
const auditLog = (event) => {
  const log = {
    timestamp: new Date().toISOString(),
    ...event
  };
  
  console.log('[AUDIT]', JSON.stringify(log));
};

// Make Circle API request
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
      timeout: 10000 // 10s timeout
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

    // Check if faucet is disabled (emergency kill switch)
    if (FAUCET_DISABLED) {
      return res.status(503).json({ 
        error: 'Faucet temporarily disabled',
        message: 'The faucet is currently under maintenance. Please try again later.'
      });
    }

    // Infrastructure DoS protection (all requests, all modes)
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                     req.headers['x-real-ip'] || 
                     'unknown';
    
    const infraCheck = checkInfraLimit(clientIp);
    if (!infraCheck.allowed) {
      auditLog({
        event: 'infra_limit_exceeded',
        ip: crypto.createHash('sha256').update(clientIp).digest('hex').substring(0, 16),
      });
      
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Please try again later.',
        resetTime: infraCheck.resetTime
      });
    }

    // Extract and validate request body
    let { address, blockchain, native, usdc, eurc, apiKey, password, mode } = req.body;

    // Immediately remove sensitive data from request object (anti-logging)
    if (apiKey) {
      const keyHash = hashApiKey(apiKey);
      auditData.apiKeyHash = keyHash.substring(0, 16);
      delete req.body.apiKey; // Never log raw API keys
    }
    if (password) {
      delete req.body.password; // Never log passwords
    }

    // Basic validation
    if (!address || !blockchain) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Address and blockchain are required'
      });
    }

    // Validate blockchain
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

    // Audit data
    auditData = {
      ...auditData,
      mode,
      blockchain,
      tokens: { native, usdc, eurc },
      walletHash: crypto.createHash('sha256').update(address).digest('hex').substring(0, 16),
      ipHash: crypto.createHash('sha256').update(clientIp).digest('hex').substring(0, 16)
    };

    let circleApiKey = '';

    // MODE 1: User's own API key (BYO)
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
      
      // Check if key is revoked
      if (REVOKED_KEY_HASHES.includes(keyHash)) {
        auditLog({ ...auditData, event: 'revoked_key_attempt' });
        return res.status(403).json({
          error: 'API key revoked',
          message: 'This API key has been revoked. Please contact support.'
        });
      }

      circleApiKey = apiKey;
      
      // NO RATE LIMITING for BYO mode
      // Let Circle enforce their own limits (they vary: 5-10 claims/day)
      // Users manage their own quota
    } 
    // MODE 2: Default faucet (password protected, our keys)
    else if (mode === 'default') {
      if (!password) {
        return res.status(400).json({ 
          error: 'Password required',
          message: 'Please provide the faucet password'
        });
      }

      // Validate password
      const inputHash = hashPassword(password);
      if (inputHash !== DEFAULT_PASSWORD_HASH) {
        auditLog({ ...auditData, event: 'invalid_password', ip: auditData.ipHash });
        return res.status(401).json({ 
          error: 'Invalid password',
          message: 'The password you entered is incorrect'
        });
      }

      // Get available API keys
      const apiKeys = getApiKeys();
      if (apiKeys.length === 0) {
        return res.status(503).json({ 
          error: 'No API keys configured',
          message: 'Default faucet is not available. Please use your own API key.'
        });
      }

      // Rotate through keys
      const keyIndex = Math.floor(Date.now() / 10000) % apiKeys.length;
      circleApiKey = apiKeys[keyIndex];

      // STRICT rate limits for default mode
      // 1. IP-based limit
      const ipHash = crypto.createHash('sha256').update(clientIp).digest('hex');
      const ipLimit = checkRateLimit(`ip:${ipHash}`, 3, 24 * 60 * 60 * 1000);
      
      if (!ipLimit.allowed) {
        auditLog({ ...auditData, event: 'ip_limit_exceeded' });
        return res.status(429).json({
          error: 'IP rate limit exceeded',
          message: 'Too many claims from your IP address. Wait 24 hours or use your own API key.',
          resetTime: ipLimit.resetTime
        });
      }

      // 2. Wallet-based limit
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
      
      // Record limits for default mode
      recordRateLimit(`ip:${ipHash}`);
      recordRateLimit(`wallet:${walletHash}`);
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

    // Make request to Circle API
    const circleResponse = await makeCircleRequest(circleApiKey, payload);

    // Handle successful claim
    if (circleResponse.statusCode >= 200 && circleResponse.statusCode < 300) {
      auditData.success = true;
      auditData.duration = Date.now() - startTime;
      auditLog({ ...auditData, event: 'claim_success' });
      
      return res.status(200).json({
        success: true,
        message: 'Tokens claimed successfully',
        transactionId: circleResponse.data.transactionId || circleResponse.data.id,
        data: circleResponse.data
      });
    }

    // Handle Circle API errors (including their rate limits)
    auditLog({ 
      ...auditData, 
      event: 'circle_api_error',
      statusCode: circleResponse.statusCode,
      error: circleResponse.data.message
    });
    
    return res.status(circleResponse.statusCode).json({
      error: 'Circle API error',
      message: circleResponse.data.message || 'Failed to claim tokens',
      code: circleResponse.data.code,
      details: circleResponse.data
    });

  } catch (error) {
    console.error('Error:', error);
    auditLog({ 
      ...auditData, 
      event: 'internal_error',
      error: error.message 
    });
    
    return res.status(500).json({ 
      error: 'Internal server error',
      message: 'An unexpected error occurred. Please try again.'
    });
  }
}
