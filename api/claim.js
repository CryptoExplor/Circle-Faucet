/**
 * POST /api/claim — testnet token claim endpoint.
 *
 * v2.1.2 — correctness pass over the v2.1.1 rewrite. Behavioural contract
 * for clients (paths, status codes, JSON field names, including the
 * `supported` list on unsupported-chain 400s) is unchanged. Guarantees:
 *
 *  - All shared state (wallet locks, IP limits, key rotation, analytics) uses
 *    ATOMIC Vercel KV commands. Every KV command is deadline-bounded and the
 *    whole request shares one budget (CLAIM_REQUEST_BUDGET_MS, default 8s):
 *    the Circle fallback inherits the REMAINING budget, and if too little is
 *    left to attempt a claim the reservations are released and 503 is
 *    returned before anything is sent. Analytics are awaited only while the
 *    request is under half its budget and are otherwise DROPPED (they are
 *    lossy counters and never run after the response). The design target is
 *    maxDuration 10s for KV latencies up to ~1.3s per command; beyond that,
 *    requests degrade to fail-closed 503s whose wall time is bounded by the
 *    per-command deadlines (1.5s) rather than by the budget. A failed
 *    release during a KV brownout CAN leave the conservative 24h lock: the
 *    release is retried and audited with the exact Redis key, and
 *    scripts/clear-lock.mjs removes it manually.
 *  - Wallet addresses are validated per chain; a canonical identity form
 *    keys the rate limits (case/whitespace/short-form bypass fixed) while the
 *    user's own spelling is sent to Circle.
 *  - The per-wallet lock is ownership-tokened. Acquire sets a 90s
 *    PROVISIONAL TTL; the 24h TTL is then established WRITE-AHEAD — an
 *    awaited atomic EXPIRE before anything is sent to Circle (failure there
 *    fails closed with nothing sent). Because the extension precedes the
 *    send, ANY post-send freeze, crash or dropped work leaves the
 *    conservative 24h lock, and there is no lock work after the response.
 *    Pre-send orphans self-heal in <=90s, definitive failures release by
 *    token, and no drip can be doubled.
 *  - Retry semantics: only a definitive 429 advances to the next API key.
 *    5xx/408/transport failures are "outcome unknown" — never retried.
 *  - The IP-based 3-claims/24h limit (configurable via IP_DAILY_LIMIT) now
 *    exists, as the UI has always advertised.
 */

import {
  makeCircleRequest,
  claimWithFallback
} from './lib/circle.js';
import { updateAnalytics } from './lib/analytics-kv.js';
import {
  acquireWalletLock,
  extendWalletLock,
  releaseWalletLock,
  reserveIpDailyClaim,
  releaseIpDailyClaim,
  checkInfraLimit,
  walletLockKey
} from './lib/rate-limit.js';
import {
  SUPPORTED_CHAINS,
  isSupportedChain,
  canonicalizeAddress,
  isSha256Hex,
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

// Whole-request wall-time budget. The function runs with maxDuration 10s;
// leave headroom for serialization and the platform itself. Read per request
// so ops/tests can tune it without reloading the module.
const getRequestBudgetMs = () => {
  const n = parseInt(process.env.CLAIM_REQUEST_BUDGET_MS, 10);
  return Number.isInteger(n) && n >= 3000 && n <= 30000 ? n : 8000;
};
// Below this there is no point starting a Circle attempt.
const MIN_CIRCLE_ATTEMPT_MS = 1500;

/**
 * Record analytics while respecting the response budget. Returns the promise
 * ONLY while the request is under half its budget — the caller awaits it in
 * that case. Past that point analytics are DROPPED: they are lossy counters
 * that must never delay the response and must never run after it (unregistered
 * post-response work has no execution guarantee on serverless). updateAnalytics
 * never rejects, so awaiting it is always safe.
 */
const scheduleAnalytics = (startTime, mode, blockchain, success, keyIndex) => {
  if (Date.now() - startTime >= getRequestBudgetMs() / 2) {
    return undefined; // deliberately dropped; see docstring
  }
  return updateAnalytics(mode, blockchain, success, keyIndex);
};

export default async function handler(req, res) {
  const startTime = Date.now();
  let auditData = { mode: null, success: false };
  let heldLock = null; // { identity, blockchain, token } while we own the lock

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

    // ---- Parse & type-validate request (cheap checks first, so junk never
    //      spends KV commands; the infra guard below covers well-formed
    //      traffic and platform/WAF layers cover raw floods) ---------------
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
        supported: SUPPORTED_CHAINS
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

    const canonical = canonicalizeAddress(address, blockchain);
    if (!canonical) {
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

    // Infrastructure DoS guard (fail-open on KV errors, see rate-limit.js)
    const infraCheck = await checkInfraLimit(clientIp);
    if (!infraCheck.allowed) {
      auditLog({ event: 'infra_limit_exceeded', ip: sha256Hex(clientIp).substring(0, 16) });
      return res.status(429).json({
        error: 'Too many requests',
        message: 'Infrastructure rate limit exceeded (100 req/hour). Please try again later.',
        resetTime: infraCheck.resetTime
      });
    }

    auditData = {
      ...auditData,
      mode,
      blockchain,
      tokens: { native, usdc, eurc },
      walletHash: sha256Hex(canonical.identity).substring(0, 16),
      ipHash: sha256Hex(clientIp).substring(0, 16)
    };

    // ---- Build Circle payload (user's own spelling goes on the wire) -----
    const payload = { address: canonical.wire, blockchain };
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
        await scheduleAnalytics(startTime, mode, blockchain, false, null);
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
        await scheduleAnalytics(startTime, mode, blockchain, true, null);
        return res.status(200).json({
          success: true,
          message: 'Tokens claimed successfully',
          transactionId: circleResponse.data.transactionId || circleResponse.data.id,
          data: circleResponse.data
        });
      }

      await scheduleAnalytics(startTime, mode, blockchain, false, null);
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
    if (!expectedHash || !isSha256Hex(expectedHash)) {
      // Fail closed: unset OR malformed (e.g. the published placeholder) can
      // never authenticate — and never by echoing the configured string.
      console.error('[ERROR] DEFAULT_PASSWORD_HASH is missing or not a sha256 hex digest');
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

    // Reserve the per-IP daily claim (atomic INCR) — protects the shared keys
    // from one client draining them through many wallets.
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
        message: 'This IP already claimed its daily limit of tokens',
        resetTime: ipReservation.resetTime
      });
    }

    // N6: bail before taking the lock if the shared budget is already spent.
    const preLockRemainingMs = getRequestBudgetMs() - (Date.now() - startTime);
    if (preLockRemainingMs < MIN_CIRCLE_ATTEMPT_MS) {
      auditLog({ ...auditData, event: 'request_budget_exhausted', preLockRemainingMs });
      await releaseIpDailyClaim(clientIp, ipReservation.day);
      return res.status(503).json({
        error: 'Faucet unavailable',
        message: 'The faucet is temporarily overloaded. Please try again in a moment.'
      });
    }

    // Acquire the atomic per-wallet claim lock — exactly one concurrent
    // claim per wallet/network wins, across all instances. The lock carries
    // a unique ownership token and starts with a 90s provisional TTL: an
    // acquire whose response was lost to a KV deadline race is detected via
    // the token, and orphans created BEFORE the 24h extension self-heal in
    // <=90s. (After the extension, the lock is 24h by design — see the
    // release paths below for how failures there are handled and audited.)
    const lock = await acquireWalletLock(canonical.identity, blockchain);
    if (lock.acquired) {
      heldLock = { identity: canonical.identity, blockchain, token: lock.token };
    }
    if (!lock.acquired && lock.contested) {
      // Definitively contested: another claimant verifiably holds the lock.
      auditLog({ ...auditData, event: 'wallet_limit_exceeded' });
      await releaseIpDailyClaim(clientIp, ipReservation.day);
      return res.status(429).json({
        error: 'Wallet rate limit exceeded',
        message: 'This wallet already claimed tokens on this network in the last 24 hours',
        resetTime: new Date(Date.now() + 24 * 60 * 60 * 1000)
      });
    }
    if (!lock.acquired) {
      // KV misbehaved during acquire (deadline raced the SET, or the
      // ownership check failed too). Fail closed, but NOT at the wallet's
      // expense: ownership-checked cleanup removes our lock if it applied,
      // the IP slot is returned, and any residual orphan self-heals in <=90s.
      // (If the cleanup itself fails, the lock expires with its provisional
      // 90s TTL — pre-extension, so no 24h orphan is possible here.)
      const cleaned = await releaseWalletLock(canonical.identity, blockchain, lock.token);
      await releaseIpDailyClaim(clientIp, ipReservation.day);
      auditLog({
        ...auditData,
        event: 'wallet_lock_uncertain',
        lockReleased: cleaned,
        ...(cleaned ? {} : { lockKey: walletLockKey(canonical.identity, blockchain) })
      });
      return res.status(503).json({
        error: 'Faucet unavailable',
        message: 'The default faucet is temporarily unavailable. Please try again later.'
      });
    }

    // Bounded parallel cleanup. The cap bounds only how long a degraded KV
    // can delay the RESPONSE. Lock-release failures are NOT silently
    // absorbed: after the write-ahead extension the lock holds a 24h TTL, so
    // a failed release burns the wallet for a day. The release itself
    // retries internally; if it still fails (or the cap elapses first) we
    // emit an audit event carrying the exact Redis key so ops can alert and
    // clear it with scripts/clear-lock.mjs. IP counters need no such
    // treatment — they are bucket-scoped and roll over with their window.
    const lockKey = walletLockKey(canonical.identity, blockchain);
    const releaseReservations = async () => {
      const cap = new Promise((r) => {
        const t = setTimeout(r, 1600);
        if (typeof t.unref === 'function') t.unref();
      });
      const settled = await Promise.race([
        Promise.all([
          releaseWalletLock(canonical.identity, blockchain, lock.token),
          releaseIpDailyClaim(clientIp, ipReservation.day)
        ]).then(([lockReleased]) => ({ timedOut: false, lockReleased })),
        cap.then(() => ({ timedOut: true, lockReleased: null }))
      ]);
      if (settled.timedOut) {
        auditLog({ ...auditData, event: 'lock_release_timeout', lockKey });
      } else if (!settled.lockReleased) {
        auditLog({ ...auditData, event: 'lock_release_failed', lockKey });
      }
    };

    // N5: establish the 24h TTL WRITE-AHEAD. Awaited BEFORE anything is sent
    // to Circle: if it fails we fail closed with nothing sent, and every
    // post-send failure mode (freeze, crash, dropped work) then leaves the
    // conservative 24h lock. If the send is later abandoned on an orderly
    // error path, releaseReservations removes the lock by token.
    const extended = await extendWalletLock(canonical.identity, blockchain, lock.token);
    if (!extended) {
      console.error('[ERROR] Could not establish the 24h wallet lock (KV failure)');
      auditLog({ ...auditData, event: 'wallet_lock_extend_failed', lockKey });
      await releaseReservations();
      return res.status(503).json({
        error: 'Faucet unavailable',
        message: 'The default faucet is temporarily unavailable. Please try again later.'
      });
    }

    // N2: the Circle fallback inherits the REMAINING request budget — a fresh
    // deadline here would let slow-but-alive KV push the total past maxDuration.
    const remainingBudgetMs = getRequestBudgetMs() - (Date.now() - startTime);
    if (remainingBudgetMs < MIN_CIRCLE_ATTEMPT_MS) {
      // Nothing has been sent to Circle: release everything and bail.
      auditLog({ ...auditData, event: 'request_budget_exhausted', remainingBudgetMs });
      await releaseReservations();
      return res.status(503).json({
        error: 'Faucet unavailable',
        message: 'The faucet is temporarily overloaded. Please try again in a moment.'
      });
    }

    // ---- Call Circle with bounded, ambiguity-safe fallback ----------------
    // If this throws (e.g. a KV failure while advancing rotation) NOTHING has
    // been sent to Circle — release both reservations so the wallet/IP are
    // not burned by an infrastructure blip, then let the outer handler 500.
    let result;
    try {
      result = await claimWithFallback(payload, {
        keys: apiKeys,
        totalDeadlineMs: remainingBudgetMs
      });
    } catch (error) {
      await releaseReservations();
      throw error;
    }

    const usedKeyIndex = result.keyIndex;

    if (result.outcome === 'success') {
      auditData.success = true;
      auditData.duration = Date.now() - startTime;
      auditLog({ ...auditData, event: 'claim_success', keyIndex: usedKeyIndex });
      await scheduleAnalytics(startTime, mode, blockchain, true, usedKeyIndex);
      // The 24h lock was established write-ahead; success simply keeps it.
      heldLock = null;
      return res.status(200).json({
        success: true,
        message: 'Tokens claimed successfully',
        transactionId: result.response.data.transactionId || result.response.data.id,
        data: result.response.data
      });
    }

    if (result.outcome === 'budget_exhausted') {
      // The rotation INCR consumed the remaining budget: nothing was sent.
      // Release everything — the wallet/IP are not punished for slow KV.
      auditLog({ ...auditData, event: 'request_budget_exhausted', keyIndex: usedKeyIndex });
      await releaseReservations();
      await scheduleAnalytics(startTime, mode, blockchain, false, usedKeyIndex);
      return res.status(503).json({
        error: 'Faucet unavailable',
        message: 'The faucet is temporarily overloaded. Please try again in a moment.'
      });
    }

    if (result.outcome === 'unknown') {
      // Ambiguous (transport loss, or Circle 5xx/408 that may have executed
      // the drip): keep lock + IP reservation (prevents double drip), tell
      // the user to check their wallet instead of blindly retrying.
      auditLog({
        ...auditData,
        event: 'claim_unknown',
        error: result.error?.message,
        statusCode: result.statusCode,
        keyIndex: usedKeyIndex
      });
      await scheduleAnalytics(startTime, mode, blockchain, false, usedKeyIndex);
      // Possibly dispensed: the wallet stays locked — the 24h TTL was already
      // established write-ahead, so nothing post-send is required to keep it.
      heldLock = null; // intentionally KEPT (24h from the write-ahead extend)
      const upstreamError = typeof result.statusCode === 'number';
      return res.status(upstreamError ? 502 : 503).json({
        error: 'Outcome unknown',
        message:
          'The claim request was sent but the response was lost. The claim may or may not have succeeded — check the wallet balance before retrying.'
      });
    }

    // Definitive failure (Circle rejected the request): give the wallet and
    // the IP their quota back.
    await releaseReservations();
    await scheduleAnalytics(startTime, mode, blockchain, false, usedKeyIndex);

    if (result.outcome === 'exhausted') {
      auditLog({ ...auditData, event: 'keys_exhausted', statusCode: result.lastResponse?.statusCode });
      return res.status(result.lastResponse?.statusCode || 429).json({
        error: 'All API keys exhausted',
        message: 'All faucet API keys are currently rate-limited. Please try again later.'
      });
    }

    // circle_error: definitive non-429, non-5xx rejection from Circle
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

    // Last-resort sweep: if we still hold an unconfirmed lock at this point,
    // nothing was dispensed (all dispensing paths handle the lock explicitly).
    if (heldLock) {
      const released = await releaseWalletLock(heldLock.identity, heldLock.blockchain, heldLock.token);
      if (!released) {
        auditLog({
          event: 'lock_release_failed',
          mode: auditData.mode,
          lockKey: walletLockKey(heldLock.identity, heldLock.blockchain)
        });
      }
    }

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
