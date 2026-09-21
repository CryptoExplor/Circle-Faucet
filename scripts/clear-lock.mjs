#!/usr/bin/env node
/**
 * clear-lock.mjs — operator tool: remove a stuck wallet claim lock.
 *
 * Why this exists: the wallet lock is write-ahead-extended to 24h BEFORE the
 * Circle request is sent (the conservative direction), so a release that
 * fails during a KV brownout can leave a 24h lock on a wallet that received
 * nothing. Such failures are retried and audited with the exact Redis key,
 * and this script is the manual clearance path.
 *
 * Usage:
 *   node scripts/clear-lock.mjs <address> <chain>
 *   e.g. node scripts/clear-lock.mjs 0xAb58...eC9B ETH-SEPOLIA
 *
 * Requires KV_REST_API_URL / KV_REST_API_TOKEN in the environment (as
 * configured on the Vercel project). The lock key is derived exactly the way
 * api/lib/rate-limit.js derives it — a bare Redis key cannot be reversed
 * into an address, which is why this helper exists.
 */

import { canonicalizeAddress, isSupportedChain, SUPPORTED_CHAINS } from '../api/lib/validate.js';
import { walletLockKey } from '../api/lib/rate-limit.js';
import { getKv } from '../api/lib/kv.js';

const argv = process.argv.slice(2);
const assumeYes = argv.includes('--yes');
const [address, chain] = argv.filter((a) => a !== '--yes');

if (!address || !chain) {
  console.error('Usage: node scripts/clear-lock.mjs <address> <chain> [--yes]');
  console.error(`Supported chains: ${SUPPORTED_CHAINS.join(', ')}`);
  console.error('');
  console.error('Without --yes the script is a DRY RUN: it shows the lock key,');
  console.error('holder-token prefix and remaining TTL, then exits.');
  process.exit(1);
}

if (!isSupportedChain(chain)) {
  console.error(`Unsupported chain "${chain}"`);
  process.exit(1);
}

const canonical = canonicalizeAddress(address, chain);
if (!canonical) {
  console.error(`"${address}" is not a valid ${chain} address`);
  process.exit(1);
}

const key = walletLockKey(canonical.identity, chain);

try {
  const kv = await getKv();
  const existing = await kv.get(key);
  if (existing === null) {
    console.log(`No lock found for ${canonical.identity} on ${chain} (${key})`);
    process.exit(0);
  }
  const ttl = await kv.ttl(key);

  // N13: a lock held by a SUCCESSFUL claim is legitimate (24h by design) and
  // looks identical to a stuck one here. Never delete without explicit intent.
  if (!assumeYes) {
    console.log(`Lock found: ${key}`);
    console.log(`  holder token: ${String(existing).slice(0, 8)}…   TTL remaining: ${ttl}s`);
    console.log('DRY RUN — nothing was deleted. Re-run with --yes to delete.');
    console.log('');
    console.log('Before deleting, cross-check the audit log: the newest event for');
    console.log('this wallet should be lock_release_failed/lock_release_timeout —');
    console.log('a lock whose newest event is claim_success is LEGITIMATE (that');
    console.log('wallet claimed and must stay locked for 24h).');
    process.exit(0);
  }

  const deleted = await kv.del(key);
  console.log(
    deleted > 0
      ? `Deleted lock ${key} (was held by token ${String(existing).slice(0, 8)}…, TTL was ${ttl}s)`
      : `Failed to delete lock ${key}`
  );
  process.exit(deleted > 0 ? 0 : 1);
} catch (error) {
  console.error(`KV error: ${error.message}`);
  console.error('Check KV_REST_API_URL / KV_REST_API_TOKEN in the environment.');
  process.exit(1);
}
