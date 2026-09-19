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

import { getKv } from './kv.js';
import { sha256Hex, clientIpBucket } from './validate.js';

export const WALLET_LOCK_TTL_SECONDS = 24 * 60 * 60;
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
 * Atomic per-wallet claim lock: SET NX EX — exactly one caller wins.
 * Fail-closed: throws on KV errors.
 * @param {string} identity canonical address identity (see validate.js)
 * @param {string} blockchain validated chain id
 * @param {{now?: number, ttlSeconds?: number}} opts
 * @returns {Promise<boolean>} true if the lock was acquired
 */
export async function acquireWalletLock(identity, blockchain, opts = {}) {
  const ttl = opts.ttlSeconds ?? WALLET_LOCK_TTL_SECONDS;
  const kv = await getKv();
  const key = walletLockKey(identity, blockchain);
  const result = await kv.set(key, '1', { nx: true, ex: ttl });
  return result === 'OK';
}

/**
 * Release the wallet lock after a DEFINITIVE failure so an address that never
 * received tokens is not burned for 24h. Never called for ambiguous outcomes.
 * @param {string} identity canonical address identity
 * @param {string} blockchain
 */
export async function releaseWalletLock(identity, blockchain) {
  try {
    const kv = await getKv();
    await kv.del(walletLockKey(identity, blockchain));
  } catch (error) {
    console.error('[RATE_LIMIT] failed to release wallet lock:', error.message);
  }
}

function walletLockKey(identity, blockchain) {
  return `faucet:lock:${sha256Hex(identity + ':' + blockchain)}`;
}
