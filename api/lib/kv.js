/**
 * KV client accessor with BOUNDED latency.
 *
 * Two properties the raw @vercel/kv default client does not give us:
 *
 * 1. NO RETRIES — @upstash/redis defaults to 5 retries with exponential
 *    backoff and no request timeout. Measured against a dead endpoint the
 *    default client throws only after ~11.7s, which is longer than the
 *    function's whole maxDuration (10s): every request in every mode would
 *    504 during a KV outage, and the "fail-open"/"fail-closed" policies
 *    would never get to run. The client is therefore created with
 *    `retry: false` (single attempt, ~4ms on a dead endpoint).
 * 2. HARD DEADLINE — even with retries off, a hanging KV endpoint never
 *    resolves. Every command is raced against KV_COMMAND_TIMEOUT_MS
 *    (default 1500ms), so callers' failure policies (fail-open infra guard,
 *    fail-closed default faucet) execute inside the function budget.
 *
 * Failure policies live in the callers (see rate-limit.js).
 */

const KV_COMMAND_TIMEOUT_MS_DEFAULT = 1500;
let kvCommandTimeoutMs = Number(process.env.KV_COMMAND_TIMEOUT_MS) || KV_COMMAND_TIMEOUT_MS_DEFAULT;

/** Test-only: shrink the per-command deadline so hangs fail fast in tests.
 *  A non-positive value restores the default. */
export function setKvTimeoutForTests(ms) {
  kvCommandTimeoutMs =
    Number(ms) > 0 ? Number(ms) : Number(process.env.KV_COMMAND_TIMEOUT_MS) || KV_COMMAND_TIMEOUT_MS_DEFAULT;
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    // Deliberately NOT unref'd: this deadline is the mechanism that rescues
    // the request from a hanging KV, so it must be allowed to fire.
    timer = setTimeout(() => reject(new Error(`KV command timed out: ${label}`)), kvCommandTimeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const COMMANDS = [
  'get', 'set', 'del', 'incr', 'decr', 'expire', 'hget', 'hgetall',
  'hincrby', 'hset', 'ttl', 'exists', 'scan'
];

let injected = null;
let realClientPromise = null;

function wrapClient(client) {
  const wrapped = {};
  for (const name of COMMANDS) {
    const fn = client[name];
    if (typeof fn !== 'function') continue;
    wrapped[name] = (...args) => withTimeout(Promise.resolve(fn.apply(client, args)), name);
  }
  // Pipeline support: 1 round trip for N commands (analytics hot path).
  if (typeof client.pipeline === 'function') {
    wrapped.pipeline = () => {
      const p = client.pipeline();
      const wrappedPipeline = {};
      for (const name of COMMANDS) {
        if (typeof p[name] === 'function') {
          wrappedPipeline[name] = (...args) => {
            p[name](...args);
            return wrappedPipeline;
          };
        }
      }
      wrappedPipeline.exec = () => withTimeout(p.exec(), 'pipeline.exec');
      return wrappedPipeline;
    };
  }
  return wrapped;
}

/**
 * Return the active KV client with every command deadline-bounded.
 * @returns {Promise<object>}
 */
export async function getKv() {
  if (injected) return injected;
  if (!realClientPromise) {
    realClientPromise = import('@vercel/kv').then((mod) => {
      const { KV_REST_API_URL, KV_REST_API_TOKEN } = process.env;
      if (!KV_REST_API_URL || !KV_REST_API_TOKEN) {
        throw new Error('KV_REST_API_URL/KV_REST_API_TOKEN are not configured');
      }
      // createClient passes config through to @upstash/redis; `retry: false`
      // selects a single attempt (no exponential-backoff retry loop).
      return wrapClient(mod.createClient({
        url: KV_REST_API_URL,
        token: KV_REST_API_TOKEN,
        retry: false
      }));
    });
  }
  return realClientPromise;
}

/**
 * Test-only: replace the KV client (e.g. with an in-memory fake).
 * @param {object|null} client
 */
export function setKvClientForTests(client) {
  injected = client ? wrapClient(client) : null;
  realClientPromise = null;
}
