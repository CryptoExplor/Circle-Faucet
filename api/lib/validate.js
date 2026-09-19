/**
 * Input validation and canonicalization.
 *
 * Security invariants enforced here:
 *  - The chain allowlist is checked with Object.hasOwn (prototype-safe, so
 *    "__proto__" / "constructor" / "toString" can never pass).
 *  - Wallet addresses are canonicalized (trimmed, lower/upper per chain rules)
 *    BEFORE hashing into rate-limit identifiers, so the same wallet cannot
 *    bypass the per-wallet limit by changing letter case or padding.
 *  - Password comparison is constant-time.
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
 * Validate + canonicalize a wallet address for the given chain.
 * Returns the canonical form, or null if the address is invalid.
 * The canonical form is what MUST be used for rate-limit identifiers.
 * @param {string} address
 * @param {string} blockchain
 * @returns {string|null}
 */
export function canonicalizeAddress(address, blockchain) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim().replace(/^0X/, '0x'); // accept 0X prefix variant
  if (!trimmed || trimmed.length > 128) return null;

  const chain = CHAINS[blockchain];
  if (!chain) return null;

  if (chain.kind === 'evm') {
    if (!EVM_ADDRESS.test(trimmed)) return null;
    return trimmed.toLowerCase();
  }
  if (chain.kind === 'solana') {
    if (!SOLANA_ADDRESS.test(trimmed)) return null;
    return trimmed; // base58 is case-sensitive; format is already canonical
  }
  // aptos
  if (!APTOS_ADDRESS.test(trimmed)) return null;
  return '0x' + trimmed.slice(2).toLowerCase().replace(/^0+/, '') || '0x0';
}

/**
 * Constant-time comparison of a plaintext input against a stored hex digest
 * (e.g. DEFAULT_PASSWORD_HASH = sha256(password) as 64 hex chars). The input
 * is hashed so digests are fixed-length; the stored digest is hex-decoded.
 * Falls back to hashing a malformed stored value so behavior stays constant.
 * @param {string} input plaintext
 * @param {string} expectedHex sha-256 hex digest
 * @returns {boolean}
 */
export function safeEqualHex(input, expectedHex) {
  if (typeof input !== 'string' || typeof expectedHex !== 'string') return false;
  const digestInput = crypto.createHash('sha256').update(input).digest();
  const digestExpected = /^[0-9a-fA-F]{64}$/.test(expectedHex)
    ? Buffer.from(expectedHex, 'hex')
    : crypto.createHash('sha256').update(expectedHex).digest();
  return crypto.timingSafeEqual(digestInput, digestExpected);
}

/**
 * Constant-time string comparison (compares SHA-256 digests so length is fixed).
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
