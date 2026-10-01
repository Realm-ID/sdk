/**
 * SessionStateStore — SPEC §6.7.5 (v0.63.0).
 *
 * ONE interface behind every piece of cross-request session state the SDK
 * keeps: revoked sessions, the not-before marks, and the §10.1 step 4a refresh
 * lock + outcome handoff. REQUIRED and passed explicitly to `createRealm`, even
 * the in-memory one: a silent default let a multi-replica partner believe the
 * refresh lock was shared when each replica held its own.
 *
 * Times are epoch milliseconds. Keys are opaque strings the SDK builds
 * (`realmid:v1:...`, components escaped, joined with `|`).
 */

/** H = 24 h, the issuer's access-TTL ceiling (SPEC §6.7.2). */
export const SESSION_STATE_H_MS = 24 * 60 * 60 * 1000;

export interface SessionState {
  revoked: boolean;
  /** Not-before mark, epoch ms; 0 = none. */
  notBefore: number;
}

export interface RefreshLock {
  acquired: boolean;
  /** FENCED: frees the lock only if this holder still owns it. */
  release: () => Promise<void>;
}

export interface SessionStateStore {
  /** Marks `key` revoked until the LATEST `untilMs` ever written; never shortens. Atomic per key. */
  revokeSession(key: string, untilMs: number): Promise<void>;
  /** Stores max(stored, nbMs) and extends life to max(stored until, untilMs), in ONE atomic step. */
  raiseNotBefore(key: string, nbMs: number, untilMs: number): Promise<void>;
  /** Live state of each key, in order (zero value for absent/expired). One round trip. */
  sessionStates(keys: string[]): Promise<SessionState[]>;
  /** Drops every entry whose key equals `prefix` or starts with `prefix|`. */
  evict(prefix: string): Promise<void>;
  /** Set-if-absent with TTL, atomically (Redis `SET key token NX PX ttl`). */
  acquireRefreshLock(key: string, ttlMs: number): Promise<RefreshLock>;
  /** `result` is an opaque SDK-encoded outcome holding live credentials: store as a secret, for exactly `ttlMs`. */
  putRefreshResult(key: string, result: string, ttlMs: number): Promise<void>;
  getRefreshResult(key: string): Promise<string | undefined>;
}

export interface MemorySessionStoreOptions {
  now?: () => number;
}

interface Entry { revoked: boolean; notBefore: number; until: number }

class MemorySessionStore implements SessionStateStore {
  private readonly entries = new Map<string, Entry>();
  private readonly locks = new Map<string, { token: symbol; until: number }>();
  private readonly results = new Map<string, { value: string; until: number }>();
  private readonly now: () => number;

  constructor(opts: MemorySessionStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  async revokeSession(key: string, untilMs: number): Promise<void> {
    const e = this.live(key) ?? { revoked: false, notBefore: 0, until: 0 };
    e.revoked = true;
    e.until = Math.max(e.until, untilMs);
    this.entries.set(key, e);
  }

  async raiseNotBefore(key: string, nbMs: number, untilMs: number): Promise<void> {
    const e = this.live(key) ?? { revoked: false, notBefore: 0, until: 0 };
    e.notBefore = Math.max(e.notBefore, nbMs);
    e.until = Math.max(e.until, untilMs);
    this.entries.set(key, e);
  }

  async sessionStates(keys: string[]): Promise<SessionState[]> {
    return keys.map((k) => {
      const e = this.live(k);
      return e ? { revoked: e.revoked, notBefore: e.notBefore } : { revoked: false, notBefore: 0 };
    });
  }

  async evict(prefix: string): Promise<void> {
    if (prefix === "") {
      this.entries.clear();
      return;
    }
    for (const k of [...this.entries.keys()]) {
      if (k === prefix || k.startsWith(prefix + "|")) this.entries.delete(k);
    }
  }

  async acquireRefreshLock(key: string, ttlMs: number): Promise<RefreshLock> {
    const cur = this.locks.get(key);
    if (cur && cur.until > this.now()) return { acquired: false, release: async () => {} };
    const token = Symbol("lock");
    this.locks.set(key, { token, until: this.now() + ttlMs });
    return {
      acquired: true,
      release: async () => {
        if (this.locks.get(key)?.token === token) this.locks.delete(key);
      },
    };
  }

  async putRefreshResult(key: string, result: string, ttlMs: number): Promise<void> {
    this.results.set(key, { value: result, until: this.now() + ttlMs });
  }

  async getRefreshResult(key: string): Promise<string | undefined> {
    const r = this.results.get(key);
    if (!r) return undefined;
    if (r.until <= this.now()) {
      this.results.delete(key);
      return undefined;
    }
    return r.value;
  }

  private live(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.until <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }
}

/** Single-replica store. Two stores share nothing. */
export function createMemorySessionStore(opts: MemorySessionStoreOptions = {}): SessionStateStore {
  const m = new MemorySessionStore(opts);
  // Own-property methods (not prototype) so a test can spread/wrap the store.
  const store: SessionStateStore = {
    revokeSession: (k, u) => m.revokeSession(k, u),
    raiseNotBefore: (k, n, u) => m.raiseNotBefore(k, n, u),
    sessionStates: (k) => m.sessionStates(k),
    evict: (p) => m.evict(p),
    acquireRefreshLock: (k, t) => m.acquireRefreshLock(k, t),
    putRefreshResult: (k, r, t) => m.putRefreshResult(k, r, t),
    getRefreshResult: (k) => m.getRefreshResult(k),
  };
  MEMORY_STORES.add(store);
  return store;
}

const MEMORY_STORES = new WeakSet<object>();

/** True for a store made by {@link createMemorySessionStore} itself (not a wrapper of it). */
export function isMemorySessionStore(s: SessionStateStore): boolean {
  return MEMORY_STORES.has(s);
}

// ---- key namespaces (SPEC §6.7.5) ----

const NS = "realmid:v1:";
const esc = (s: string): string => s.replace(/%/g, "%25").replace(/\|/g, "%7C");
async function hex(s: string): Promise<string> {
  const d = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const revKey = (sessionKey: string): string => `${NS}rev|${esc(sessionKey)}`;
export const nbKey = (sessionKey: string): string => `${NS}nb|${esc(sessionKey)}`;
export const nbMemberKey = (sessionKey: string, sub: string): string => `${NS}nb|${esc(sessionKey)}|${esc(sub)}`;
export const lockKey = async (refreshToken: string): Promise<string> => `${NS}lock|${await hex(refreshToken)}`;
export const outKey = async (refreshToken: string): Promise<string> => `${NS}out|${await hex(refreshToken)}`;

/** `sid` when a non-empty string, else `jti` when a non-empty string, else "" (SPEC §6.7.1). */
export function sessionKeyOf(c: { sid?: unknown; jti?: unknown }): string {
  if (typeof c.sid === "string" && c.sid !== "") return c.sid;
  if (typeof c.jti === "string" && c.jti !== "") return c.jti;
  return "";
}

/**
 * Conformance helper: run a candidate store (e.g. Redis) through the same
 * atomicity/lifetime cases the in-memory store passes. Throws on the first
 * violation. `makeStore` receives a controllable clock the store must honour.
 */
export async function sessionStoreConformance(
  makeStore: (clock: { now: () => number }) => SessionStateStore,
): Promise<void> {
  const fail = (m: string): never => { throw new Error("SessionStateStore conformance: " + m); };
  let t = 1_000_000;
  const clock = { now: () => t };
  const s = makeStore(clock);
  await s.revokeSession("k", t + 1000);
  await s.revokeSession("k", t + 10);
  t += 500;
  if (!(await s.sessionStates(["k"]))[0]!.revoked) fail("RevokeSession shortened an entry");
  t += 600;
  if ((await s.sessionStates(["k"]))[0]!.revoked) fail("revoked entry outlived its until");
  await s.raiseNotBefore("n", 50, t + 1000);
  await s.raiseNotBefore("n", 20, t + 2000);
  const st = (await s.sessionStates(["n", "absent"]));
  if (st[0]!.notBefore !== 50) fail("RaiseNotBefore lowered the mark");
  if (st[1]!.revoked || st[1]!.notBefore !== 0) fail("absent key not zero");
  t += 1500;
  if ((await s.sessionStates(["n"]))[0]!.notBefore !== 50) fail("RaiseNotBefore did not extend life");
  await s.revokeSession("k2", t + 1000);
  await s.revokeSession("k", t + 1000);
  await s.revokeSession("k|x", t + 1000);
  await s.evict("k");
  const after = await s.sessionStates(["k", "k|x", "k2"]);
  if (after[0]!.revoked || after[1]!.revoked || !after[2]!.revoked) fail("Evict must drop k and k|* but not k2");
  const l1 = await s.acquireRefreshLock("l", 1000);
  const l2 = await s.acquireRefreshLock("l", 1000);
  if (!l1.acquired || l2.acquired) fail("lock is not set-if-absent");
  t += 1001;
  const l3 = await s.acquireRefreshLock("l", 1000);
  if (!l3.acquired) fail("lock TTL not honoured");
  await l1.release();
  if ((await s.acquireRefreshLock("l", 1000)).acquired) fail("stale release freed a lock held by another (not fenced)");
  await s.putRefreshResult("o", "v", 100);
  if ((await s.getRefreshResult("o")) !== "v") fail("result missing");
  t += 101;
  if ((await s.getRefreshResult("o")) !== undefined) fail("result TTL not exact");
}
