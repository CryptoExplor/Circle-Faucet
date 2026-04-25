import https    from 'https';
import crypto   from 'crypto';
import { kv }   from '@vercel/kv';
import {
  updateAnalytics,
  getNextKeyIndex,
} from './lib/analytics-kv.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_PASSWORD_HASH = process.env.DEFAULT_PASSWORD_HASH ?? '';
const CIRCLE_API_KEYS       = process.env.CIRCLE_API_KEYS ?? '';
const FAUCET_DISABLED       = process.env.FAUCET_DISABLED === 'true';
const REVOKED_KEY_HASHES    = (process.env.REVOKED_API_KEY_HASHES ?? '').split(',').filter(Boolean);

const SUPPORTED_CHAINS = {
  'ARC-TESTNET':    'ARC-TESTNET',
  'ETH-SEPOLIA':    'ETH-SEPOLIA',
  'AVAX-FUJI':      'AVAX-FUJI',
  'MATIC-AMOY':     'MATIC-AMOY',
  'SOL-DEVNET':     'SOL-DEVNET',
  'ARB-SEPOLIA':    'ARB-SEPOLIA',
  'UNI-SEPOLIA':    'UNI-SEPOLIA',
  'BASE-SEPOLIA':   'BASE-SEPOLIA',
  'OP-SEPOLIA':     'OP-SEPOLIA',
  'APTOS-TESTNET':  'APTOS-TESTNET',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const getApiKeys = () =>
  CIRCLE_API_KEYS.split(',').map(k => k.trim()).filter(Boolean);

const hashStr = (s) =>
  crypto.createHash('sha256').update(s).digest('hex');

const validateApiKey = (key) => {
  if (!key || typeof key !== 'string') return false;
  const parts = key.split(':');
  return parts.length === 3 && parts[0] === 'TEST_API_KEY';
};

// ---------------------------------------------------------------------------
// Rate limiting — KV-backed so it survives cold starts
//
// FIX: the original implementation stored timestamps in a Map() on the
// global object.  Vercel serverless functions can spin up many isolated
// instances; each had its own Map, so the 100 req/hr cap was per-instance
// (effectively unlimited) rather than per-IP across all instances.
//
// New approach: KV sliding-window counter.
//   key  : faucet:rl:ip:<sha256-of-ip>
//   value: request count in the current window
//   TTL  : 3600 s (resets automatically — no cleanup needed)
// ---------------------------------------------------------------------------
const INFRA_LIMIT  = 100;          // requests per window
const INFRA_WINDOW = 60 * 60;      // seconds

async function checkAndRecordInfraLimit(ip) {
  const key = `faucet:rl:ip:${hashStr(ip).slice(0, 32)}`;
  try {
    // incr creates the key at 0 then increments; returns new count
    const count = await kv.incr(key);
    if (count === 1) {
      // First request in this window — set the TTL
      await kv.expire(key, INFRA_WINDOW);
    }
    const allowed = count <= INFRA_LIMIT;
    if (!allowed) console.warn('[RATE_LIMIT] infra limit hit for hashed IP:', key);
    return { allowed, count };
  } catch (err) {
    // KV unavailable — fail open (don't block legitimate traffic)
    console.error('[RATE_LIMIT] KV error, failing open:', err.message);
    return { allowed: true, count: 0 };
  }
}

// Wallet-level: 1 claim per wallet+chain per 24 h (unchanged, still KV)
const WALLET_WINDOW = 24 * 60 * 60;

async function checkWalletLimit(address, blockchain) {
  const key = `faucet:rl:wallet:${hashStr(address + blockchain).slice(0, 32)}`;
  try {
    const exists = await kv.exists(key);
    if (exists) return { allowed: false };
    // Mark as claimed; expires after 24 h
    await kv.set(key, 1, { ex: WALLET_WINDOW });
    return { allowed: true };
  } catch (err) {
    console.error('[RATE_LIMIT] wallet KV error, failing open:', err.message);
    return { allowed: true };
  }
}

// ---------------------------------------------------------------------------
// Circle API
// ---------------------------------------------------------------------------
function makeCircleRequest(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const options = {
      hostname: 'api.circle.com',
      port:     443,
      path:     '/v1/faucet/drips',
      method:   'POST',
      headers:  {
        Authorization:   `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10_000,
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ statusCode: res.statusCode, data: { raw: raw.slice(0, 200) } });
        }
      });
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

async function makeCircleRequestWithFallback(payload) {
  const keys = getApiKeys();
  if (!keys.length) throw new Error('No API keys configured');

  let lastResponse = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    // FIX: use atomic getNextKeyIndex instead of read-modify-write
    const keyIndex = await getNextKeyIndex(keys.length);
    const apiKey   = keys[keyIndex];

    try {
      console.log(`[FALLBACK] attempt ${attempt + 1}/${keys.length} key index ${keyIndex}`);
      const response = await makeCircleRequest(apiKey, payload);

      if (response.statusCode >= 200 && response.statusCode < 300) {
        return { response, keyIndex };
      }

      // Rate-limited or quota exceeded — try next key
      if (response.statusCode === 429 || response.data?.code === 5) {
        console.warn(`[FALLBACK] key ${keyIndex} rate-limited, trying next`);
        lastResponse = response;
        continue;
      }

      // Any other error — return immediately (don't retry)
      return { response, keyIndex };
    } catch (err) {
      console.error(`[FALLBACK] key ${keyIndex} threw:`, err.message);
      lastResponse = { statusCode: 500, data: { error: err.message } };
    }
  }

  return {
    response: lastResponse ?? { statusCode: 503, data: { error: 'All API keys exhausted' } },
    keyIndex: null,
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
const auditLog = (event) =>
  console.log('[AUDIT]', JSON.stringify({ timestamp: new Date().toISOString(), ...event }));

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const startTime = Date.now();
  let   auditData = { mode: null, success: false };

  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  if (FAUCET_DISABLED) {
    return res.status(503).json({
      error:   'Faucet temporarily disabled',
      message: 'The faucet is under maintenance. Please try again later.',
    });
  }

  // Client IP
  const clientIp = (req.headers['x-forwarded-for']?.split(',')[0]
    ?? req.headers['x-real-ip']
    ?? 'unknown').trim();

  // Infra rate limit (KV-backed, cross-instance)
  const infraCheck = await checkAndRecordInfraLimit(clientIp);
  if (!infraCheck.allowed) {
    auditLog({ event: 'infra_limit_exceeded', ipHash: hashStr(clientIp).slice(0, 16) });
    return res.status(429).json({
      error:   'Too many requests',
      message: 'Rate limit exceeded (100 req/hour). Please try again later.',
    });
  }

  // Parse body
  const {
    address, blockchain,
    native, usdc, eurc,
    apiKey, password, mode,
  } = req.body ?? {};

  // Basic validation
  if (!address || !blockchain) {
    return res.status(400).json({ error: 'Missing required fields', message: 'address and blockchain are required' });
  }
  if (!SUPPORTED_CHAINS[blockchain]) {
    return res.status(400).json({
      error:     'Unsupported blockchain',
      message:   `"${blockchain}" is not supported`,
      supported: Object.keys(SUPPORTED_CHAINS),
    });
  }
  if (!native && !usdc && !eurc) {
    return res.status(400).json({ error: 'No tokens selected', message: 'Select at least one token' });
  }

  auditData = {
    ...auditData,
    mode,
    blockchain,
    tokens:     { native, usdc, eurc },
    walletHash: hashStr(address).slice(0, 16),
    ipHash:     hashStr(clientIp).slice(0, 16),
  };

  // ----- Mode: own-key -----
  let circleApiKey = '';
  let usesFallback = false;
  let usedKeyIndex = null;

  if (mode === 'own-key') {
    if (!apiKey) {
      return res.status(400).json({ error: 'API key required', message: 'Provide your Circle API key' });
    }
    if (!validateApiKey(apiKey)) {
      auditLog({ ...auditData, event: 'invalid_api_key_format' });
      return res.status(400).json({ error: 'Invalid API key', message: 'Expected format: TEST_API_KEY:xxx:xxx' });
    }
    const keyHash = hashStr(apiKey);
    if (REVOKED_KEY_HASHES.includes(keyHash)) {
      auditLog({ ...auditData, event: 'revoked_key_attempt' });
      return res.status(403).json({ error: 'API key revoked' });
    }
    circleApiKey = apiKey;

  // ----- Mode: default -----
  } else if (mode === 'default') {
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }
    if (hashStr(password) !== DEFAULT_PASSWORD_HASH) {
      auditLog({ ...auditData, event: 'invalid_password' });
      return res.status(401).json({ error: 'Invalid password' });
    }
    if (!getApiKeys().length) {
      return res.status(503).json({ error: 'No API keys configured' });
    }

    // Wallet-level rate limit
    const walletCheck = await checkWalletLimit(address, blockchain);
    if (!walletCheck.allowed) {
      auditLog({ ...auditData, event: 'wallet_limit_exceeded' });
      return res.status(429).json({
        error:   'Wallet rate limit exceeded',
        message: 'This wallet already claimed tokens on this network in the last 24 hours',
      });
    }

    usesFallback = true;
  } else {
    return res.status(400).json({ error: 'Invalid mode', message: 'mode must be "own-key" or "default"' });
  }

  // Build payload
  const payload = { address, blockchain: SUPPORTED_CHAINS[blockchain] };
  if (native) payload.native = true;
  if (usdc)   payload.usdc   = true;
  if (eurc)   payload.eurc   = true;

  // Call Circle
  try {
    let circleResponse;

    if (usesFallback) {
      const result  = await makeCircleRequestWithFallback(payload);
      circleResponse = result.response;
      usedKeyIndex   = result.keyIndex;
    } else {
      circleResponse = await makeCircleRequest(circleApiKey, payload);
    }

    if (circleResponse.statusCode >= 200 && circleResponse.statusCode < 300) {
      auditData.success  = true;
      auditData.duration = Date.now() - startTime;
      auditLog({ ...auditData, event: 'claim_success', keyIndex: usedKeyIndex });
      await updateAnalytics(mode, blockchain, true, usedKeyIndex);

      return res.status(200).json({
        success:       true,
        message:       'Tokens claimed successfully',
        transactionId: circleResponse.data.transactionId ?? circleResponse.data.id,
        data:          circleResponse.data,
      });
    }

    await updateAnalytics(mode, blockchain, false, usedKeyIndex);
    auditLog({ ...auditData, event: 'circle_api_error', statusCode: circleResponse.statusCode });

    return res.status(circleResponse.statusCode).json({
      error:   'Circle API error',
      message: circleResponse.data.message ?? 'Failed to claim tokens',
      code:    circleResponse.data.code,
      details: circleResponse.data,
    });

  } catch (err) {
    console.error('[FATAL]', err);
    auditLog({ ...auditData, event: 'internal_error', error: err.message });
    if (auditData.mode && auditData.blockchain) {
      await updateAnalytics(auditData.mode, auditData.blockchain, false);
    }
    return res.status(500).json({
      error:   'Internal server error',
      message: 'An unexpected error occurred. Please try again.',
    });
  }
}
