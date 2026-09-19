/**
 * POST /api/claim — testnet token claim endpoint.
 *
 * v2.1.1 — security & correctness rewrite. Behavioural contract for clients
 * (paths, status codes, JSON field names) is unchanged. Internal changes:
 *
 *  - All shared state (wallet locks, IP limits, key rotation, analytics) moved
 *    from in-memory Maps to ATOMIC Vercel KV commands, so limits hold across
 *    serverless instances and cold starts.
 *  - Wallet addresses are validated per chain and canonicalized before they
 *    are hashed into rate-limit identifiers (case/whitespace bypass fixed).
 *  - Chain allowlist check is prototype-safe (Object.hasOwn).
 *  - Password comparison is constant-time.
 *  - The per-wallet 24h lock is ACQUIRED before the Circle call and RELEASED
 *    only on definitive failure — an address is never burned for 24h because
 *    the faucet was out of keys, and a genuinely ambiguous outcome (transport
 *    error after the drip may have been issued) keeps the lock to avoid a
 *    double drip.
 *  - The IP-based 3-claims/24h limit advertised in the UI/docs now exists.
 *  - Retry semantics: only a definitive 429 advances to the next API key;
 *    ambiguous transport failures are never retried.
 *  - The documented IP limit, Circle request timeout and total deadline are
 *    budgeted to stay inside the function's maxDuration.
 */

import {
  makeCircleRequest,
  claimWithFallback
} from './lib/circle.js';
import { updateAnalytics } from './lib/analytics-kv.js';
import {
  acquireWalletLock,
  releaseWalletLock,
  reserveIpDailyClaim,
  releaseIpDailyClaim,
  checkInfraLimit
} from './lib/rate-limit.js';
import {
  isSupportedChain,
  canonicalizeAddress,
  safeEqualHex,
  sha256Hex,
  isValidCircleKeyFormat
} from './lib/validate.js';

const auditLog = (event) => {
  console.log('[AUDIT]', JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
};

const getApiKeys = () =>
  (process.env.CIRCLE_API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

export default async function handler(req, res) {
  const startTime = Date.now();
  let auditData = { mode: null, success: false };

  try {
    // CORS (mirrors vercel.json; no credentials, no wildcard+credentials combo)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (process.env.FAUCET_DISABLED === 'true') {
      return res.status(503).json({
        error: 'Faucet temporarily disabled',
        message: 'The faucet is currently under maintenance. Please try again later.'
      });
    }

    const clientIp =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      'unknown';

    // Infrastructure DoS guard (fail-open, see rate-limit.js)
    const infraCheck = await checkInfraLimit(clientIp);
    if (!infraCheck.allowed) {
      auditLog({ event: 'infra_limit_exceeded', ip: sha256Hex(clientIp).substring(0, 16) });
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Infrastructure rate limit exceeded (100 req/hour). Please try again later.',
        resetTime: infraCheck.resetTime
      });
    }

    // ---- Parse & type-validate request -----------------------------------
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) || {};
    const {
      address,
      blockchain,
      native,
      usdc,
      eurc,
      apiKey,
      password,
      mode
    } = body;

    console.log('[REQUEST]', {
      address: typeof address === 'string' ? address.substring(0, 10) + '...' : undefined,
      blockchain,
      mode,
      tokens: { native, usdc, eurc }
    });

    if (!address || !blockchain) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Address and blockchain are required'
      });
    }

    if (!isSupportedChain(blockchain)) {
      return res.status(400).json({
        error: 'Unsupported blockchain',
        message: `Blockchain "${String(blockchain)}" is not supported`,
        supported: undefined // never reflect internal enumerations blindly
      });
    }

    if (typeof mode !== 'string' || (mode !== 'own-key' && mode !== 'default')) {
      return res.status(400).json({
        error: 'Invalid mode',
        message: 'Please select a valid claim mode (own-key or default)'
      });
    }

    if (typeof password === 'string' && password.length > 1024) {
      return res.status(400).json({ error: 'Invalid input', message: 'Input too long' });
    }

    const canonicalAddress = canonicalizeAddress(address, blockchain);
    if (!canonicalAddress) {
      return res.status(400).json({
        error: 'Invalid address',
        message: `The address is not a valid ${blockchain} address`
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
      walletHash: sha256Hex(canonicalAddress).substring(0, 16),
      ipHash: sha256Hex(clientIp).substring(0, 16)
    };

    // ---- Build Circle payload --------------------------------------------
    const payload = { address: canonicalAddress, blockchain };
    if (native) payload.native = true;
    if (usdc) payload.usdc = true;
    if (eurc) payload.eurc = true;

    // ---- MODE 1: user's own API key --------------------------------------
    if (mode === 'own-key') {
      if (typeof apiKey !== 'string' || !apiKey) {
        return res.status(400).json({
          error: 'API key required',
          message: 'Please provide your Circle API key'
        });
      }
      if (!isValidCircleKeyFormat(apiKey)) {
        auditLog({ ...auditData, event: 'invalid_api_key_format' });
        return res.status(400).json({
          error: 'Invalid API key',
          message: 'API key format is invalid. Expected: TEST_API_KEY:xxx:xxx'
        });
      }

      const revokedHashes = (process.env.REVOKED_API_KEY_HASHES || '').split(',').filter(Boolean);
      if (revokedHashes.includes(sha256Hex(apiKey))) {
        auditLog({ ...auditData, event: 'revoked_key_attempt' });
        return res.status(403).json({
          error: 'API key revoked',
          message: 'This API key has been revoked. Please contact support.'
        });
      }

      auditData.apiKeyHash = sha256Hex(apiKey).substring(0, 16);

      let circleResponse;
      try {
        circleResponse = await makeCircleRequest(apiKey, payload);
      } catch (error) {
        // Ambiguous outcome: the drip may exist. Never auto-retry.
        auditLog({ ...auditData, event: 'claim_unknown', error: error.message });
        await updateAnalytics(mode, blockchain, false, null);
        return res.status(503).json({
          error: 'Outcome unknown',
          message:
            'The faucet API could not be reached after the request was sent. The claim may or may not have succeeded — check the wallet balance before retrying.'
        });
      }

      console.log('[CIRCLE_RESPONSE]', { statusCode: circleResponse.statusCode });

      if (circleResponse.statusCode >= 200 && circleResponse.statusCode < 300) {
        auditData.success = true;
        auditData.duration = Date.now() - startTime;
        auditLog({ ...auditData, event: 'claim_success' });
        await updateAnalytics(mode, blockchain, true, null);
        return res.status(200).json({
          success: true,
          message: 'Tokens claimed successfully',
          transactionId: circleResponse.data.transactionId || circleResponse.data.id,
          data: circleResponse.data
        });
      }

      await updateAnalytics(mode, blockchain, false, null);
      auditLog({
        ...auditData,
        event: 'circle_api_error',
        statusCode: circleResponse.statusCode,
        error: circleResponse.data?.message
      });
      return res.status(circleResponse.statusCode).json({
        error: 'Circle API error',
        message: circleResponse.data?.message || 'Failed to claim tokens',
        code: circleResponse.data?.code
      });
    }

    // ---- MODE 2: default faucet ------------------------------------------
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({
        error: 'Password required',
        message: 'Please provide the faucet password'
      });
    }

    const expectedHash = (process.env.DEFAULT_PASSWORD_HASH || '').trim();
    if (!expectedHash) {
      // Fail closed: no password configured means nobody authenticates.
      console.error('[ERROR] DEFAULT_PASSWORD_HASH is not configured');
      return res.status(503).json({
        error: 'Faucet not configured',
        message: 'Default faucet is not available. Please use your own API key.'
      });
    }
    if (!safeEqualHex(password.trim(), expectedHash)) {
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

    // Reserve the per-IP daily claim (3/24h, atomic INCR) — protects the
    // shared keys from one client draining them through many wallets.
    let ipReservation;
    try {
      ipReservation = await reserveIpDailyClaim(clientIp);
    } catch (error) {
      console.error('[ERROR] KV unavailable for IP limit:', error.message);
      return res.status(503).json({
        error: 'Faucet unavailable',
        message: 'The default faucet is temporarily unavailable. Please try again later.'
      });
    }
    if (!ipReservation.allowed) {
      auditLog({ ...auditData, event: 'ip_limit_exceeded' });
      return res.status(429).json({
        error: 'IP rate limit exceeded',
        message: 'This IP already claimed 3 tokens in the last 24 hours',
        resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
    }

    // Acquire the atomic per-wallet 24h lock (SET NX EX) — exactly one
    // concurrent claim per wallet/network wins, across all instances.
    let lockAcquired = false;
    try {
      lockAcquired = await acquireWalletLock(canonicalAddress, blockchain);
    } catch (error) {
      console.error('[ERROR] KV unavailable for wallet lock:', error.message);
      await releaseIpDailyClaim(clientIp);
      return res.status(503).json({
        error: 'Faucet unavailable',
        message: 'The default faucet is temporarily unavailable. Please try again later.'
      });
    }
    if (!lockAcquired) {
      auditLog({ ...auditData, event: 'wallet_limit_exceeded' });
      await releaseIpDailyClaim(clientIp);
      return res.status(429).json({
        error: 'Wallet rate limit exceeded',
        message: 'This wallet already claimed tokens on this network in the last 24 hours',
        resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
    }

    // ---- Call Circle with bounded, ambiguity-safe fallback ----------------
    const result = await claimWithFallback(payload, { keys: apiKeys });
    const usedKeyIndex = result.keyIndex;

    const releaseReservations = async () => {
      await releaseWalletLock(canonicalAddress, blockchain);
      await releaseIpDailyClaim(clientIp);
    };

    if (result.outcome === 'success') {
      auditData.success = true;
      auditData.duration = Date.now() - startTime;
      auditLog({ ...auditData, event: 'claim_success', keyIndex: usedKeyIndex });
      await updateAnalytics(mode, blockchain, true, usedKeyIndex);
      return res.status(200).json({
        success: true,
        message: 'Tokens claimed successfully',
        transactionId: result.response.data.transactionId || result.response.data.id,
        data: result.response.data
      });
    }

    if (result.outcome === 'unknown') {
      // Ambiguous: keep lock + IP reservation (prevents double drip), tell
      // the user to check their wallet instead of blindly retrying.
      auditLog({ ...auditData, event: 'claim_unknown', error: result.error.message, keyIndex: usedKeyIndex });
      await updateAnalytics(mode, blockchain, false, usedKeyIndex);
      return res.status(503).json({
        error: 'Outcome unknown',
        message:
          'The claim request was sent but the response was lost. The claim may or may not have succeeded — check the wallet balance before retrying.'
      });
    }

    // Definitive failure (Circle rejected the request): give the wallet and
    // the IP their quota back.
    await releaseReservations();
    await updateAnalytics(mode, blockchain, false, usedKeyIndex);

    if (result.outcome === 'exhausted') {
      auditLog({ ...auditData, event: 'keys_exhausted', statusCode: result.lastResponse?.statusCode });
      return res.status(result.lastResponse?.statusCode || 429).json({
        error: 'All API keys exhausted',
        message: 'All faucet API keys are currently rate-limited. Please try again later.'
      });
    }

    // circle_error: definitive non-429 rejection from Circle
    auditLog({
      ...auditData,
      event: 'circle_api_error',
      statusCode: result.response.statusCode,
      error: result.response.data?.message,
      keyIndex: usedKeyIndex
    });
    return res.status(result.response.statusCode).json({
      error: 'Circle API error',
      message: result.response.data?.message || 'Failed to claim tokens',
      code: result.response.data?.code
    });
  } catch (error) {
    console.error('[FATAL_ERROR]', error);
    auditLog({
      ...auditData,
      event: 'internal_error',
      error: error.message,
      stack: error.stack
    });

    if (auditData.mode && auditData.blockchain) {
      await updateAnalytics(auditData.mode, auditData.blockchain, false);
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: 'An unexpected error occurred. Please try again.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}
