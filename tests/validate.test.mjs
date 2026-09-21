import { test } from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {
  isSupportedChain,
  canonicalizeAddress,
  isSha256Hex,
  safeEqualHex,
  safeEqual,
  clientIpBucket,
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

test('EVM addresses: identity and wire both collapse case/whitespace variants', () => {
  const c1 = canonicalizeAddress('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B', 'ETH-SEPOLIA');
  const c2 = canonicalizeAddress('0xab5801a7d398351b8be11c439e05c5b3259aec9b', 'ETH-SEPOLIA');
  const c3 = canonicalizeAddress('  0XAB5801A7D398351B8BE11C439E05C5B3259AEC9B\n', 'ETH-SEPOLIA');
  assert.equal(c1.identity, c2.identity);
  assert.equal(c2.identity, c3.identity);
  assert.equal(c1.wire, c1.identity, 'EVM wire is the lowercased address');
});

test('EVM address validation rejects malformed input', () => {
  assert.equal(canonicalizeAddress('0x123', 'ETH-SEPOLIA'), null);
  assert.equal(canonicalizeAddress('0xZZ5801a7D398351b8bE11C439e05C5B3259aeC9B', 'ETH-SEPOLIA'), null);
  assert.equal(canonicalizeAddress('Ab5801a7D398351b8bE11C439e05C5B3259aeC9B', 'ETH-SEPOLIA'), null);
  assert.equal(canonicalizeAddress('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9Bextra', 'ETH-SEPOLIA'), null);
  assert.equal(canonicalizeAddress({}, 'ETH-SEPOLIA'), null);
  assert.equal(canonicalizeAddress('0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B', 'SOL-DEVNET'), null);
});

test('solana addresses validate and keep case sensitivity', () => {
  const addr = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
  assert.equal(canonicalizeAddress(addr, 'SOL-DEVNET').wire, addr);
  assert.equal(canonicalizeAddress(addr.toLowerCase(), 'SOL-DEVNET'), null, 'lowercased base58 is invalid and rejected');
});

test('M3: aptos wire form is NEVER re-encoded (leading zeros preserved)', () => {
  // 64-digit address with leading zeros — the exact case the old code broke
  const full = '0x' + '00' + 'ab'.repeat(31);
  const c = canonicalizeAddress(full, 'APTOS-TESTNET');
  assert.equal(c.wire, full, 'wire must keep the user\u2019s spelling including leading zeros');
  assert.equal(c.identity, full.toLowerCase(), 'identity is the lowercase full form');

  // short form: identity is zero-padded (short+long share one quota),
  // wire is the short form, not '0x' (precedence-bug regression)
  const short = canonicalizeAddress('0xABCDEF', 'APTOS-TESTNET');
  assert.equal(short.wire, '0xabcdef');
  assert.equal(short.identity, '0x' + 'abcdef'.padStart(64, '0'));

  // short and padded spellings share ONE identity
  const padded = canonicalizeAddress('0x' + '0'.repeat(58) + 'abcdef', 'APTOS-TESTNET');
  assert.equal(padded.identity, short.identity);
});

test('M2: safeEqualHex fails CLOSED on malformed stored digests', () => {
  const good = crypto.createHash('sha256').update('pw').digest('hex');
  assert.equal(safeEqualHex('x', 'your_password_hash_here'), false, 'placeholder can never authenticate');
  assert.equal(safeEqualHex('your_password_hash_here', 'your_password_hash_here'), false);
  assert.equal(safeEqualHex('pw', good.toUpperCase()), true, 'case-insensitive hex accepted');
  assert.equal(safeEqualHex('pw', 'zz'), false);
  assert.equal(safeEqualHex('pw', ''), false);
  assert.equal(safeEqualHex('pw', good), true);
  assert.equal(safeEqualHex('wrong', good), false);
});

test('safeEqual remains for arbitrary admin-token comparison', () => {
  assert.equal(safeEqual('tok', 'tok'), true);
  assert.equal(safeEqual('tok', 'tok2'), false);
  assert.equal(safeEqual(undefined, 'x'), false);
});

test('M4: IPv6 clients are bucketed by /64', () => {
  assert.equal(clientIpBucket('2001:db8:1:2:3:4:5:6'), '2001:0db8:0001:0002:/64');
  assert.equal(
    clientIpBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd'),
    clientIpBucket('2001:db8:1:2::1'),
    'same /64 -> same bucket'
  );
  assert.notEqual(
    clientIpBucket('2001:db8:1:2::1'),
    clientIpBucket('2001:db8:1:3::1'),
    'different /64 -> different bucket'
  );
  assert.equal(clientIpBucket('203.0.113.7'), '203.0.113.7', 'IPv4 unchanged');
  assert.equal(clientIpBucket('fe80::1%eth0'), 'fe80:0000:0000:0000:/64', 'zone id stripped');
});

test('circle key format validation', () => {
  assert.equal(isValidCircleKeyFormat('TEST_API_KEY:id:secret'), true);
  assert.equal(isValidCircleKeyFormat('TEST_API_KEY::secret'), false);
  assert.equal(isValidCircleKeyFormat('LIVE_API_KEY:id:secret'), false);
  assert.equal(isValidCircleKeyFormat('TEST_API_KEY:id'), false);
  assert.equal(isValidCircleKeyFormat(null), false);
});
