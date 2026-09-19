import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSupportedChain,
  canonicalizeAddress,
  safeEqual,
  isValidCircleKeyFormat,
  SUPPORTED_CHAINS
} from '../api/lib/validate.js';

test('chain allowlist is prototype-safe', () => {
  for (const evil of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(isSupportedChain(evil), false, `"${evil}" must be rejected`);
  }
  assert.equal(isSupportedChain('ETH-SEPOLIA'), true);
  assert.equal(isSupportedChain('eth-sepolia'), false, 'exact match only');
  assert.equal(isSupportedChain(undefined), false);
  assert.equal(isSupportedChain(['ETH-SEPOLIA']), false);
  assert.equal(SUPPORTED_CHAINS.length, 10);
});

test('EVM address canonicalization: case and whitespace variants collapse to one identity', () => {
  const c1 = canonicalizeAddress('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B', 'ETH-SEPOLIA');
  const c2 = canonicalizeAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b', 'ETH-SEPOLIA');
  const c3 = canonicalizeAddress('  0XAB5801A7D398351B8BE11C439E05C5B3259AEC9B\n', 'ETH-SEPOLIA');
  assert.equal(c1, c2);
  assert.equal(c2, c3);
  assert.equal(c1, '0xab5801a7d398351b8be11c439e05c5b3259aec9b');
});

test('EVM address validation rejects malformed input', () => {
  assert.equal(canonicalizeAddress('0x123', 'ETH-SEPOLIA'), null); // too short
  assert.equal(canonicalizeAddress('0xZZ5801a7D398351b8bE11C439e05C5B3259aeC9B', 'ETH-SEPOLIA'), null);
  assert.equal(canonicalizeAddress('Ab5801a7D398351b8bE11C439e05C5B3259aeC9B', 'ETH-SEPOLIA'), null); // no 0x
  assert.equal(canonicalizeAddress('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9Bextra', 'ETH-SEPOLIA'), null);
  assert.equal(canonicalizeAddress({}, 'ETH-SEPOLIA'), null);
  assert.equal(canonicalizeAddress('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B', 'SOL-DEVNET'), null, 'evm addr on solana rejected');
});

test('solana addresses validate and keep case sensitivity', () => {
  const addr = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
  assert.equal(canonicalizeAddress(addr, 'SOL-DEVNET'), addr);
  assert.equal(canonicalizeAddress(addr.toLowerCase(), 'SOL-DEVNET'), null, 'lowercased base58 is invalid and rejected');
  assert.equal(canonicalizeAddress('zzzz', 'SOL-DEVNET'), null); // 0lI are not in base58 alphabet
});

test('aptos addresses canonicalize to lowercase', () => {
  const c = canonicalizeAddress('0xABCDEF', 'APTOS-TESTNET');
  assert.equal(c, '0xabcdef');
});

test('safeEqual is constant-shape and correct', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secrets'), false);
  assert.equal(safeEqual('', ''), true); // both empty -> equal digests; callers gate on empty beforehand
  assert.equal(safeEqual(undefined, 'x'), false);
  assert.equal(safeEqual(5, 5), false);
});

test('circle key format validation', () => {
  assert.equal(isValidCircleKeyFormat('TEST_API_KEY:id:secret'), true);
  assert.equal(isValidCircleKeyFormat('TEST_API_KEY::secret'), false);
  assert.equal(isValidCircleKeyFormat('LIVE_API_KEY:id:secret'), false);
  assert.equal(isValidCircleKeyFormat('TEST_API_KEY:id'), false);
  assert.equal(isValidCircleKeyFormat(null), false);
});
