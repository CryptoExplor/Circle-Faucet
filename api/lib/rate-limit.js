/**
 * Atomic, KV-backed rate limits and locks.
 *
 * WHY KV AND NOT IN-MEMORY MAPs:
 * Vercel serverless functions scale horizontally and restart. A module-level
 * Map is per-instance and per-lifetime, so any in-memory limit is bypassed by
 * concurrency alone (parallel requests hit different instances) and by cold
 * starts. Every primitive below is a single atomic Redis command:
 *   - SET key val NX EX  -> atomic acquire with TTL (wallet lock)
 *   - INCR / DECR        -> fixed-window counters (IP limits)
 *
 * Window semantics: IP counters use UTC calendar buckets keyed directly in
 * the key name (`...:<dayBucket>`), so a bucket is never read again once the
 * epoch moves on — a missed EXPIRE can only leave a little garbage, never a
 * permanent lock. The EXPIRE itself is best-effort.
 *
 * Failure policy (all decisions run within the KV command deadline, see
 * lib/kv.js — no unbounded waits):
 *   - infra limit: fail-open (availability of BYO-key mode matters more, and
 *     default mode independently fails closed below)
 *   - wallet lock + IP daily reserve: fail-closed (they protect the shared
 *     Circle API keys; without KV the default faucet is unavailable)
 *
 * Configuration (read per call so tests and ops can tune without redeploy
 * gymnastics):
 *   IP_DAILY_LIMIT   default 3   — default-mode claims per IP per UTC day
 *   IP_INFRA_LIMIT   default 100 — raw requests per IP per UTC hour, all modes
 */

import crypto from 'node:crypto';
import { getKv } from './kv.js';
import { sha256Hex, clientIpBucket } from './validate.js';

/**
 * Wallet-lock lifecycle (N1 hardening):
 *
 * A KV command deadline is a CLIENT-side race — it cannot cancel the command,
 * so a timed-out `SET NX` may still have applied server-side. A blind release
 * would then be impossible (we hold no proof of ownership) and a blind DEL
 * could destroy another claimant's lock. Therefore:
 *
 *  1. The lock value is a UNIQUE per-request token. Only the creator knows it,
 *     so GET-compare-then-DEL is a safe ownership-checked release without Lua.
 *  2. The acquire TTL is PROVISIONAL (90s). Any orphaned lock — acquired but
 *     never confirmed because the request died mid-KV-outage — self-heals in
 *     at most 90 seconds. No wallet can be burned for 24h by infrastructure.
 *  3. After Circle gives a TERMINAL outcome (success, or unknown-but-possibly-
 *     dispensed), the holder CONFIRMS the lock, extending it to 24h.
 *  4. Definitive failure releases via token compare-and-delete immediately.
 *
 * Residual risk (documented): if the confirm call itself fails on the
 * "unknown outcome" path, the lock evaporates after <=90s and the wallet may
 * retry; a second drip is then blocked by Circle's own per-address cap
 * (definitive 4xx), so no double dispensation is possible — worst case is a
 * confusing one-off 429/400, never a double claim.
 */
export const WALLET_LOCK_PROVISIONAL_TTL_SECONDS = 90;
export const WALLET_LOCK_CONFIRMED_TTL_SECONDS = 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const ipDailyLimit = () => {
  const n = parseInt(process.env.IP_DAILY_LIMIT, 10);
  return Number.isInteger(n) && n > 0 ? n : 3;
};
const ipInfraLimit = () => {
  const n = parseInt(process.env.IP_INFRA_LIMIT, 10);
  return Number.isInteger(n) && n > 0 ? n : 100;
};

/**
 * Infrastructure DoS guard (all modes). Fail-open on KV errors.
 * @param {string} ip raw client ip (bucketed + hashed inside)
 * @param {{now?: number}} opts
 * @returns {Promise<{allowed: boolean, resetTime?: Date}>}
 */
export async function checkInfraLimit(ip, opts = {}) {
  const now = opts.now ?? Date.now();
  try {
    const kv = await getKv();
    const bucket = Math.floor(now / HOUR_MS);
    const key = `faucet:rl:infra:${sha256Hex(clientIpBucket(ip)).slice(0, 24)}:${bucket}`;
    const count = await kv.incr(key);
    if (count === 1) {
      // Best-effort: the bucket id in the key already makes old windows
      // unreadable, so a failed EXPIRE only leaves garbage, not locks.
      await kv.expire(key, 2 * 60 * 60).catch(() => {});
    }
    if (count > ipInfraLimit()) {
      return { allowed: false, resetTime: new Date((bucket + 1) * HOUR_MS) };
    }
    return { allowed: true };
  } catch (error) {
    console.error('[RATE_LIMIT] infra check unavailable (fail-open):', error.message);
    return { allowed: true };
  }
}

/**
 * Default-mode guard: N claims per IP per UTC day. Returns the reservation
 * plus the day bucket, which the caller MUST pass to releaseIpDailyClaim so
 * a release near midnight decrements the bucket that was actually charged.
 * Fail-closed: throws on KV errors (caller maps to 503).
 * @param {string} ip
 * @param {{now?: number, limit?: number}} opts
 * @returns {Promise<{allowed: boolean, count: number, day: number, resetTime: Date}>}
 */
export async function reserveIpDailyClaim(ip, opts = {}) {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? ipDailyLimit();
  const kv = await getKv();
  const day = Math.floor(now / DAY_MS);
  const key = `faucet:rl:ipday:${sha256Hex(clientIpBucket(ip)).slice(0, 24)}:${day}`;
  const count = await kv.incr(key);
  if (count === 1) {
    await kv.expire(key, 2 * 24 * 60 * 60).catch(() => {});
  }
  if (count > limit) {
    // Blocked requests give their increment back immediately, otherwise the
    // counter drifts upward and a later release (below) would permanently
    // lock an innocent IP for the rest of the day.
    await kv.decr(key).catch(() => {});
    return { allowed: false, count, day, resetTime: new Date((day + 1) * DAY_MS) };
  }
  return { allowed: true, count, day, resetTime: new Date((day + 1) * DAY_MS) };
}

/**
 * Release a reserved IP claim after a DEFINITIVE failure (Circle rejected the
 * request). Pass the `day` returned by reserveIpDailyClaim — recomputing the
 * bucket from "now" would decrement the wrong day across a UTC midnight.
 * @param {string} ip
 * @param {number} day day bucket returned by the reservation
 * @param {{now?: number}} opts
 */
export async function releaseIpDailyClaim(ip, day, opts = {}) {
  if (!Number.isInteger(day)) return;
  try {
    const kv = await getKv();
    const key = `faucet:rl:ipday:${sha256Hex(clientIpBucket(ip)).slice(0, 24)}:${day}`;
    const count = await kv.decr(key);
    if (count <= 0) await kv.del(key); // don't leave zeroed garbage behind
  } catch (error) {
    console.error('[RATE_LIMIT] failed to release IP reservation:', error.message);
  }
}

/**
 * Atomic per-wallet claim lock with OWNERSHIP TOKEN and PROVISIONAL TTL.
 *
 * Never throws: a KV failure yields a verdict with `ambiguous: true` because
 * the timed-out SET may still have applied server-side. Exactly one of N
 * concurrent callers gets `acquired: true`.
 *
 * @param {string} identity canonical address identity (see validate.js)
 * @param {string} blockchain validated chain id
 * @param {{provisionalTtlSeconds?: number}} opts
 * @returns {Promise<{acquired: boolean, ambiguous: boolean, contested: boolean, token: string}>}
 *   acquired=true,  ambiguous=false -> clean acquire; caller must confirm or release
 *   acquired=true,  ambiguous=true  -> the SET applied despite an error (deadline race);
 *                                      caller owns it (provisional TTL), confirm or release
 *   acquired=false, contested=true  -> another claimant verifiably holds the lock (429)
 *   acquired=false, contested=false -> KV misbehaved and we do NOT own the lock:
 *                                      caller returns 503 (fail-closed), attempts an
 *                                      ownership-checked cleanup, and any orphan still
 *                                      self-heals in <= provisional TTL
 */
export async function acquireWalletLock(identity, blockchain, opts = {}) {
  const ttl = opts.provisionalTtlSeconds ?? WALLET_LOCK_PROVISIONAL_TTL_SECONDS;
  const kv = await getKv();
  const key = walletLockKey(identity, blockchain);
  const token = crypto.randomUUID();
  try {
    const result = await kv.set(key, token, { nx: true, ex: ttl });
    return { acquired: result === 'OK', ambiguous: false, contested: result !== 'OK', token };
  } catch (error) {
    // Deadline raced the response: the SET may still apply server-side.
    let current;
    try {
      current = await kv.get(key);
    } catch {
      current = undefined; // GET also failed — fully unknown
    }
    if (current === token) {
      // The SET applied: we own the lock (bounded by the provisional TTL).
      console.warn('[RATE_LIMIT] wallet lock SET applied despite deadline error (owned via token)');
      return { acquired: true, ambiguous: true, contested: false, token };
    }
    if (current === null) {
      // GET succeeded and shows no lock: the SET definitively did not apply.
      // This is still KV misbehavior (the SET errored), so the caller must
      // fail closed (503) — but nothing needs cleaning up.
      return { acquired: false, ambiguous: false, contested: false, token };
    }
    if (current === undefined) {
      // Even the ownership GET failed: fully unknown; cleanup attempt is the
      // caller's best effort and the provisional TTL bounds the worst case.
      return { acquired: false, ambiguous: true, contested: false, token };
    }
    // A live third-party token is in the key: verifiably contested.
    return { acquired: false, ambiguous: false, contested: true, token };
  }
}

/**
 * Confirm a held wallet lock after a terminal Circle outcome, extending it
 * from the provisional TTL to the full 24h. Ownership-checked: only succeeds
 * if the stored value still equals our token. Never throws; if this fails the
 * lock self-heals (expires) within the provisional window.
 * @param {string} identity
 * @param {string} blockchain
 * @param {string} token token returned by acquireWalletLock
 * @returns {Promise<boolean>} true if the lock was confirmed
 */
export async function confirmWalletLock(identity, blockchain, token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  try {
    const kv = await getKv();
    const key = walletLockKey(identity, blockchain);
    const current = await kv.get(key);
    if (current !== token) return false; // expired or taken over: nothing to confirm
    await kv.set(key, token, { xx: true, ex: WALLET_LOCK_CONFIRMED_TTL_SECONDS });
    return true;
  } catch (error) {
    console.error('[RATE_LIMIT] failed to confirm wallet lock (self-heals in <=90s):', error.message);
    return false;
  }
}

/**
 * Ownership-checked release: deletes the wallet lock ONLY if it still holds
 * our token. A blind DEL would be wrong — it could delete another claimant's
 * lock acquired after ours expired. Never throws.
 * @param {string} identity
 * @param {string} blockchain
 * @param {string} token token returned by acquireWalletLock
 * @returns {Promise<boolean>} true if we owned and deleted it
 */
export async function releaseWalletLock(identity, blockchain, token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  try {
    const kv = await getKv();
    const key = walletLockKey(identity, blockchain);
    const current = await kv.get(key);
    if (current !== token) return false; // not ours (anymore)
    await kv.del(key);
    return true;
  } catch (error) {
    console.error('[RATE_LIMIT] failed to release wallet lock (self-heals in <=90s):', error.message);
    return false;
  }
}

function walletLockKey(identity, blockchain) {
  return `faucet:lock:${sha256Hex(identity + ':' + blockchain)}`;
}
