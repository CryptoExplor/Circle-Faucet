/**
 * KV client accessor.
 *
 * All shared state (rate limits, wallet locks, key rotation, analytics) lives in
 * Vercel KV (Redis) and is mutated ONLY through atomic commands (INCR, HINCRBY,
 * SET NX EX, DECR). Never read-modify-write a shared document from JS.
 *
 * The client is imported lazily so that:
 *  - unit tests can inject an in-memory client without touching the network
 *  - the module can be loaded in environments where KV env vars are absent
 *    (callers must handle command failures themselves; see rate-limit.js)
 */

let injected = null;
let realClientPromise = null;

/**
 * Return the active KV client.
 * @returns {Promise<object>} client exposing get/set/del/incr/decr/expire/hincrby/hgetall
 */
export async function getKv() {
  if (injected) return injected;
  if (!realClientPromise) {
    realClientPromise = import('@vercel/kv').then((mod) => mod.kv);
  }
  return realClientPromise;
}

/**
 * Test-only: replace the KV client (e.g. with an in-memory fake).
 * @param {object|null} client
 */
export function setKvClientForTests(client) {
  injected = client;
  realClientPromise = null;
}
