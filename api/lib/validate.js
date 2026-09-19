/**
 * Input validation and canonicalization.
 *
 * Security invariants enforced here:
 *  - The chain allowlist is checked with Object.hasOwn (prototype-safe, so
 *    "__proto__" / "constructor" / "toString" can never pass).
 *  - Wallet addresses are separated into two forms:
 *      identity — canonical form used ONLY for rate-limit/lock keys, so the
 *                 same wallet cannot bypass limits by changing letter case,
 *                 padding, or short/long form;
 *      wire     — the address actually sent to Circle: the user's trimmed
 *                 input, lowercased for case-insensitive chains, but never
 *                 re-encoded (no zero-stripping/padding) so we do not send
 *                 Circle something the user did not write.
 *  - Password comparison is constant-time and FAILS CLOSED on a malformed
 *    stored digest (a placeholder like "your_password_hash_here" can never
 *    authenticate by being typed back).
 */

import crypto from 'crypto';

const CHAINS = Object.freeze({
  'ARC-TESTNET': { kind: 'evm' },
  'ETH-SEPOLIA': { kind: 'evm' },
  'AVAX-FUJI': { kind: 'evm' },
  'MATIC-AMOY': { kind: 'evm' },
  'ARB-SEPOLIA': { kind: 'evm' },
  'UNI-SEPOLIA': { kind: 'evm' },
  'BASE-SEPOLIA': { kind: 'evm' },
  'OP-SEPOLIA': { kind: 'evm' },
  'SOL-DEVNET': { kind: 'solana' },
  'APTOS-TESTNET': { kind: 'aptos' }
});

export const SUPPORTED_CHAINS = Object.keys(CHAINS);

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const APTOS_ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/i;

/**
 * Validate a chain identifier. Prototype-safe.
 * @param {unknown} blockchain
 * @returns {boolean}
 */
export function isSupportedChain(blockchain) {
  return (
    typeof blockchain === 'string' &&
    Object.hasOwn(CHAINS, blockchain)
  );
}

/**
 * Validate a wallet address and produce its identity (rate-limit key material)
 * and wire (Circle payload) forms. Returns null if the address is invalid.
 * @param {string} address
 * @param {string} blockchain
 * @returns {{identity: string, wire: string}|null}
 */
export function canonicalizeAddress(address, blockchain) {
  if (typeof address !== 'string') return null;
  // Accept the uppercase 0X prefix (never appears in valid base58, so this
  // only ever applies to hex-style addresses).
  const trimmed = address.trim().replace(/^0X/, '0x');
  if (!trimmed || trimmed.length > 128) return null;

  const chain = CHAINS[blockchain];
  if (!chain) return null;

  if (chain.kind === 'evm') {
    if (!EVM_ADDRESS.test(trimmed)) return null;
    const lower = trimmed.toLowerCase();
    return { identity: lower, wire: lower };
  }
  if (chain.kind === 'solana') {
    if (!SOLANA_ADDRESS.test(trimmed)) return null;
    return { identity: trimmed, wire: trimmed }; // base58 is case-sensitive
  }
  // aptos: hex, up to 64 digits. Identity is the zero-padded 64-digit form so
  // short/long spellings of the same account share one quota. Wire keeps the
  // user's spelling (lowercased) — we never re-encode what goes to Circle.
  if (!APTOS_ADDRESS.test(trimmed)) return null;
  const hex = trimmed.slice(2).toLowerCase();
  const normalized = hex === '' ? '0'.repeat(64) : hex.padStart(64, '0');
  return { identity: '0x' + normalized, wire: '0x' + hex };
}

/**
 * True when the value is a well-formed sha256 hex digest. Anything else
 * (including the published placeholder) must be treated as "not configured".
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSha256Hex(value) {
  return typeof value === 'string' && HEX64.test(value);
}

/**
 * Constant-time comparison of a plaintext input against a stored sha256 hex
 * digest. FAILS CLOSED: a malformed stored digest returns false (never a
 * derived comparison that a placeholder could satisfy).
 * @param {string} input plaintext
 * @param {string} expectedHex sha-256 hex digest
 * @returns {boolean}
 */
export function safeEqualHex(input, expectedHex) {
  if (typeof input !== 'string' || !isSha256Hex(expectedHex)) return false;
  const digestInput = crypto.createHash('sha256').update(input).digest();
  const digestExpected = Buffer.from(expectedHex.toLowerCase(), 'hex');
  return crypto.timingSafeEqual(digestInput, digestExpected);
}

/**
 * Constant-time string comparison for arbitrary strings (both sides hashed so
 * length is fixed). Used for the optional admin stats token.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const da = crypto.createHash('sha256').update(a).digest();
  const db = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * Rate-limit identity for a client IP. IPv6 addresses are aggregated by /64
 * so a single prefix cannot rotate through 2^64 addresses; IPv4 is used as-is.
 * @param {string} ip
 * @returns {string}
 */
export function clientIpBucket(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return 'unknown';
  const trimmed = ip.trim();
  if (!trimmed.includes(':')) return trimmed; // IPv4 or opaque
  // Normalize and truncate IPv6 to its /64 prefix. Expand enough of the
  // compressed form: use the first 4 groups after parsing via a URL-safe trick.
  const expanded = expandIpv6(trimmed);
  if (!expanded) return trimmed; // unparseable — use as-is (fail visible)
  return expanded.split(':').slice(0, 4).join(':') + ':/64';
}

function expandIpv6(addr) {
  // strip zone id
  const noZone = addr.split('%')[0];
  if (!noZone.includes(':')) return null;
  if (noZone.includes('.')) {
    // IPv4-mapped tail
    const lastColon = noZone.lastIndexOf(':');
    const v4 = noZone.slice(lastColon + 1);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return null;
    const parts = v4.split('.').map((n) => parseInt(n, 10).toString(16).padStart(2, '0'));
    return expandIpv6(noZone.slice(0, lastColon + 1) + parts[0] + parts[1] + ':' + parts[2] + parts[3]);
  }
  const pad = (g) => g.padStart(4, '0');
  const halves = noZone.split('::');
  if (halves.length > 2) return null;
  let head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  let tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    const groups = [...head, ...Array(fill).fill('0'), ...tail];
    if (groups.length !== 8) return null;
    return groups.map(pad).join(':');
  }
  if (head.length !== 8) return null;
  return head.map(pad).join(':');
}

/**
 * SHA-256 hex digest (for audit identifiers only, never for secrets in
 * user-controlled comparisons).
 * @param {string} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Circle test API keys are formatted PREFIX:ID:SECRET.
 * @param {unknown} key
 * @returns {boolean}
 */
export function isValidCircleKeyFormat(key) {
  if (typeof key !== 'string') return false;
  const parts = key.split(':');
  return parts.length === 3 && parts[0] === 'TEST_API_KEY' && parts[1].length > 0 && parts[2].length > 0;
}
