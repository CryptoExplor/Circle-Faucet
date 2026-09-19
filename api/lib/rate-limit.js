/**
 * Atomic, KV-backed rate limits and locks.
 *
 * WHY KV AND NOT IN-MEMY MAPs:
 * Vercel serverless functions scale horizontally and restart. A module-level
 * Map is per-instance and per-lifetime, so any in-memory limit is bypassed by
 * concurrency alone (parallel requests hit different instances) and by cold
 * starts. Every primitive below is a single atomic Redis command:
 *   - SET key val NX EX  -> atomic acquire with TTL (wallet lock)
 *   - INCR / DECR        -> fixed-window counters (IP limits)
 *
 * Failure policy:
 *   - infra limit: fail-open (availability of BYO-key mode matters more, and
 *     default mode independently fails closed below)
 *   - wallet lock + IP daily reserve: fail-closed (they protect the shared
 *     Circle API keys; without KV the default faucet is unavailable)
 */

import { getKv } from './kv.js';
import { sha256Hex } from './validate.js';

export const WALLET_LOCK_TTL_SECONDS = 24 * 60 * 60;
export const IP_DAILY_LIMIT = 3;
export const IP_INFRA_LIMIT = 100;

/** Hour buckets keep keys unique per window, so a missed EXPIRE can never
 *  permanently lock an identifier — the key simply stops being read next hour. */

/**
 * Infrastructure DoS guard: 100 requests/hour/IP (all modes).
 * Fail-open on KV errors.
 * @param {string} ip raw client ip (hashed inside)
 * @param {{now?: number}} opts
 * @returns {Promise<{allowed: boolean, resetTime?: Date}>}
 */
export async function checkInfraLimit(ip, opts = {}) {
  const now = opts.now ?? Date.now();
  try {
    const kv = await getKv();
    const bucket = Math.floor(now / (60 * 60 * 1000));
    const key = `faucet:rl:infra:${sha256Hex(ip).slice(0, 24)}:${bucket}`;
    const count = await kv.incr(key);
    if (count === 1) {
      await kv.expire(key, 2 * 60 * 60); // outlive the window; bucket key changes anyway
    }
    if (count > IP_INFRA_LIMIT) {
      return { allowed: false, resetTime: new Date((bucket + 1) * 60 * 60 * 1000) };
    }
    return { allowed: true };
  } catch (error) {
    console.error('[RATE_LIMIT] infra check unavailable (fail-open):', error.message);
    return { allowed: true };
  }
}

/**
 * Default-mode guard: 3 claims per IP per 24h. Returns the reservation count.
 * Fail-closed: throws on KV errors (caller maps to 503).
 * @param {string} ip
 * @param {{now?: number, limit?: number}} opts
 * @returns {Promise<{allowed: boolean, count: number}>}
 */
export async function reserveIpDailyClaim(ip, opts = {}) {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? IP_DAILY_LIMIT;
  const kv = await getKv();
  const day = Math.floor(now / (24 * 60 * 60 * 1000));
  const key = `faucet:rl:ipday:${sha256Hex(ip).slice(0, 24)}:${day}`;
  const count = await kv.incr(key);
  if (count === 1) {
    await kv.expire(key, 2 * 24 * 60 * 60);
  }
  if (count > limit) {
    // Blocked requests give their increment back immediately, otherwise the
    // counter drifts upward and a later release (below) would permanently
    // lock an innocent IP for the rest of the day.
    await kv.decr(key);
    return { allowed: false, count };
  }
  return { allowed: true, count };
}

/**
 * Release a reserved IP claim after a DEFINITIVE failure (Circle rejected the
 * request). Never called for ambiguous outcomes.
 * @param {string} ip
 * @param {{now?: number}} opts
 */
export async function releaseIpDailyClaim(ip, opts = {}) {
  const now = opts.now ?? Date.now();
  try {
    const kv = await getKv();
    const day = Math.floor(now / (24 * 60 * 60 * 1000));
    const key = `faucet:rl:ipday:${sha256Hex(ip).slice(0, 24)}:${day}`;
    const count = await kv.decr(key);
    if (count <= 0) await kv.del(key); // don't leave zeroed garbage behind
  } catch (error) {
    console.error('[RATE_LIMIT] failed to release IP reservation:', error.message);
  }
}

/**
 * Atomic per-wallet claim lock: SET NX EX — exactly one caller wins.
 * Fail-closed: throws on KV errors.
 * @param {string} canonicalAddress canonicalized address
 * @param {string} blockchain validated chain id
 * @param {{now?: number, ttlSeconds?: number}} opts
 * @returns {Promise<boolean>} true if the lock was acquired
 */
export async function acquireWalletLock(canonicalAddress, blockchain, opts = {}) {
  const ttl = opts.ttlSeconds ?? WALLET_LOCK_TTL_SECONDS;
  const kv = await getKv();
  const key = walletLockKey(canonicalAddress, blockchain);
  const result = await kv.set(key, '1', { nx: true, ex: ttl });
  return result === 'OK';
}

/**
 * Release the wallet lock after a DEFINITIVE failure so an address that never
 * received tokens is not burned for 24h. Never called for ambiguous outcomes.
 * @param {string} canonicalAddress
 * @param {string} blockchain
 */
export async function releaseWalletLock(canonicalAddress, blockchain) {
  try {
    const kv = await getKv();
    await kv.del(walletLockKey(canonicalAddress, blockchain));
  } catch (error) {
    console.error('[RATE_LIMIT] failed to release wallet lock:', error.message);
  }
}

function walletLockKey(canonicalAddress, blockchain) {
  return `faucet:lock:${sha256Hex(canonicalAddress + ':' + blockchain)}`;
}
