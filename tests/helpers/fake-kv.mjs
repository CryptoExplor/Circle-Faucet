/**
 * In-memory KV fake that mirrors the semantics of the atomic commands the
 * app uses (get/set-with-nx-ex/del/incr/decr/expire/hincrby/hgetall).
 * Commands are executed synchronously inside the resolved-promise microtask,
 * matching Redis single-threaded atomicity. TTLs are enforced lazily.
 */
export function createFakeKv() {
  const store = new Map(); // key -> { value, expiresAt: number|null }

  const alive = (entry, now) => entry && (entry.expiresAt === null || entry.expiresAt > now);

  return {
    _dump: () => store,

    async get(key) {
      const e = store.get(key);
      if (!alive(e, Date.now())) return null;
      return e.value;
    },

    async set(key, value, opts = {}) {
      const e = store.get(key);
      const exists = alive(e, Date.now());
      if (opts.nx && exists) return null;
      if (opts.xx && !exists) return null;
      store.set(key, {
        value,
        expiresAt: opts.ex ? Date.now() + opts.ex * 1000 : null
      });
      return 'OK';
    },

    async del(...keys) {
      let n = 0;
      for (const k of keys) {
        if (store.has(k)) {
          store.delete(k);
          n++;
        }
      }
      return n;
    },

    async incr(key) {
      const e = store.get(key);
      const current = alive(e, Date.now()) ? parseInt(e.value, 10) || 0 : 0;
      const next = current + 1;
      store.set(key, { value: next, expiresAt: e && alive(e, Date.now()) ? e.expiresAt : null });
      return next;
    },

    async decr(key) {
      const e = store.get(key);
      const current = alive(e, Date.now()) ? parseInt(e.value, 10) || 0 : 0;
      const next = current - 1;
      store.set(key, { value: next, expiresAt: e && alive(e, Date.now()) ? e.expiresAt : null });
      return next;
    },

    async ttl(key) {
      const e = store.get(key);
      if (!alive(e, Date.now())) return -2;
      return Math.max(0, Math.round((e.expiresAt - Date.now()) / 1000));
    },

    async expire(key, seconds) {
      const e = store.get(key);
      if (!alive(e, Date.now())) return 0;
      e.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },

    async hincrby(key, field, by) {
      let e = store.get(key);
      if (!alive(e, Date.now())) e = undefined;
      const hash = e && e.value && typeof e.value === 'object' ? e.value : {};
      hash[field] = (parseInt(hash[field], 10) || 0) + by;
      store.set(key, { value: hash, expiresAt: e ? e.expiresAt : null });
      return hash[field];
    },

    async hgetall(key) {
      const e = store.get(key);
      if (!alive(e, Date.now()) || !e.value) return null;
      return { ...e.value };
    },

    /** Command-chaining pipeline, executed in order on exec() (1 "round trip"). */
    pipeline() {
      const ops = [];
      const self = this;
      const api = {
        incr: (k) => (ops.push(['incr', k]), api),
        decr: (k) => (ops.push(['decr', k]), api),
        set: (k, v, o) => (ops.push(['set', k, v, o]), api),
        expire: (k, s) => (ops.push(['expire', k, s]), api),
        hincrby: (k, f, b) => (ops.push(['hincrby', k, f, b]), api),
        exec: async () => {
          const results = [];
          for (const [cmd, ...args] of ops) results.push(await self[cmd](...args));
          return results;
        }
      };
      return api;
    },

    /** test helper: simulate clock-driven expiry */
    _ageAll(ms) {
      for (const e of store.values()) {
        if (e.expiresAt !== null) e.expiresAt -= ms;
      }
    }
  };
}
