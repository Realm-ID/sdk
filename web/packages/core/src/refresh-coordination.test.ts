/**
 * BFF-SPEC v0.63.0 § "The browser side: one refresh across tabs", § "Org-session
 * mode in the browser", § "Logout". Cases 77-88b of the v0.63.0 checklist.
 *
 * Two TokenManagers stand in for two tabs: they share a mocked `navigator.locks`
 * and an in-memory tab bus (delivery is synchronous, which is stricter than a
 * real BroadcastChannel for "second tab adopts", and the lock-ordering tests
 * hold the lock by hand where timing matters).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { TokenManager } from "./token-manager.js";
import { Transport } from "./transport.js";
import { createTabBus, type TabBus, type TabMessage } from "./multi-tab.js";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

/* ---------------------------------------------------------------- harness */

const CHANNEL = "realmid:https://bff.test";
const LOCK = `realmid-refresh:${CHANNEL}`;

function hub() {
  const buses: Array<{ fn: Set<(m: TabMessage) => void> }> = [];
  const posted: TabMessage[] = [];
  return {
    posted,
    make(): TabBus {
      const me = { fn: new Set<(m: TabMessage) => void>() };
      buses.push(me);
      return {
        post(msg) {
          posted.push(msg);
          for (const b of buses) if (b !== me) for (const f of b.fn) f(JSON.parse(JSON.stringify(msg)));
        },
        subscribe(f) {
          me.fn.add(f);
          return () => me.fn.delete(f);
        },
        close() {
          me.fn.clear();
        },
      };
    },
  };
}

function mockLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request: async (name: string, optsOrCb: unknown, maybeCb?: () => Promise<unknown>) => {
      const cb = (maybeCb ?? optsOrCb) as () => Promise<unknown>;
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.catch(() => {}).then(() => cb());
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}

function withNavigator<T>(nav: unknown, fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true });
  return fn().finally(() => {
    if (desc) Object.defineProperty(globalThis, "navigator", desc);
    else delete (globalThis as { navigator?: unknown }).navigator;
  });
}

interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

function bff(handler: (c: Call, n: number) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  let tokenN = 0;
  let inflight = 0;
  let maxInflight = 0;
  const fn: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: Object.fromEntries(
        [...new Headers(init?.headers as HeadersInit | undefined).entries()].map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    calls.push(call);
    const isToken = call.url.endsWith("/token");
    if (isToken) {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      tokenN++;
    }
    await new Promise((r) => setImmediate(r));
    try {
      const { status, body } = await handler(call, tokenN);
      return new Response(body !== undefined ? JSON.stringify(body) : null, {
        status,
        headers: { "Content-Type": "application/json" },
      });
    } finally {
      if (isToken) inflight--;
    }
  };
  return {
    fetch: fn,
    calls,
    tokenCalls: () => calls.filter((c) => c.url.endsWith("/token")),
    maxInflight: () => maxInflight,
  };
}

function manager(
  fetchImpl: typeof fetch,
  bus: TabBus,
  extra: { tokenless?: boolean; onLost?: (r: string) => void } = {},
) {
  const transport = new Transport({ baseUrl: "https://bff.test", fetch: fetchImpl });
  return new TokenManager(transport, {
    refreshSkewMs: 60_000,
    onRefreshed: () => {},
    onLost: extra.onLost ?? (() => {}),
    adapters: {},
    requestAdapters: {},
    gates: [],
    refresh: { tokenless: extra.tokenless },
    bus,
    channelName: CHANNEL,
  } as ConstructorParameters<typeof TokenManager>[1]);
}

const okToken = (n: number, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { accessToken: `at-${n}`, expiresIn: 3600, ...extra },
});

const tick = () => new Promise((r) => setImmediate(r));

/* ------------------------------------------------------------------- 77-79 */

test("77 two tabs, same tenant, concurrent refresh -> ONE /token; the second adopts the broadcast token", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    const h = hub();
    const srv = bff((_c, n) => okToken(n));
    const a = manager(srv.fetch, h.make());
    const b = manager(srv.fetch, h.make());
    const [ta, tb] = await Promise.all([a.refresh("t1"), b.refresh("t1")]);
    assert.equal(srv.tokenCalls().length, 1, "the second tab called /token as well");
    assert.equal(ta, "at-1");
    assert.equal(tb, "at-1");
    assert.equal(b.peek("t1"), "at-1");
  });
});

test("78 same tab, two tenants refreshing concurrently are serialized", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    const h = hub();
    const srv = bff((_c, n) => okToken(n));
    const a = manager(srv.fetch, h.make());
    await Promise.all([a.refresh("t1"), a.refresh("t2")]);
    assert.equal(srv.tokenCalls().length, 2);
    assert.equal(srv.maxInflight(), 1, "the two /token calls overlapped");
  });
});

test("79a inside the lock a sibling token_refreshed (<5s, later expiry) is adopted: no /token", async () => {
  const locks = mockLocks();
  await withNavigator({ locks }, async () => {
    const h = hub();
    const srv = bff((_c, n) => okToken(n));
    const sibling = h.make();
    const b = manager(srv.fetch, h.make());
    b.set("t1", "old", 30); // inside the skew; a refresh is wanted
    let release!: () => void;
    const held = locks.request(LOCK, () => new Promise<void>((r) => (release = r)));
    const p = b.refresh("t1");
    await tick();
    sibling.post({ type: "token_refreshed", tenantId: "t1", accessToken: "from-sibling", expiresAt: Date.now() + 3_600_000 });
    release();
    await held;
    assert.equal(await p, "from-sibling");
    assert.equal(srv.tokenCalls().length, 0, "/token was called despite a fresh sibling result");
  });
});

test("79b a sibling result older than 5s, or with an earlier expiry, is NOT adopted: /token is called", async () => {
  const locks = mockLocks();
  await withNavigator({ locks }, async () => {
    const realNow = Date.now;
    try {
      // older than 5s by the time the lock frees
      {
        const h = hub();
        const srv = bff((_c, n) => okToken(n));
        const sibling = h.make();
        const b = manager(srv.fetch, h.make());
        b.set("t1", "old", 30);
        let release!: () => void;
        const held = locks.request(LOCK, () => new Promise<void>((r) => (release = r)));
        const p = b.refresh("t1");
        await tick();
        const t0 = realNow();
        sibling.post({ type: "token_refreshed", tenantId: "t1", accessToken: "from-sibling", expiresAt: t0 + 3_600_000 });
        Date.now = () => t0 + 6_000;
        release();
        await held;
        await p;
        assert.equal(srv.tokenCalls().length, 1, "a >5s-old sibling result was adopted");
        Date.now = realNow;
      }
      // earlier expiry than what is held
      {
        const h = hub();
        const srv = bff((_c, n) => okToken(n));
        const sibling = h.make();
        const b = manager(srv.fetch, h.make());
        b.set("t1", "old", 30);
        let release!: () => void;
        const held = locks.request(LOCK, () => new Promise<void>((r) => (release = r)));
        const p = b.refresh("t1");
        await tick();
        sibling.post({ type: "token_refreshed", tenantId: "t1", accessToken: "stale-sibling", expiresAt: Date.now() + 5_000 });
        release();
        await held;
        await p;
        assert.equal(srv.tokenCalls().length, 1, "an earlier-expiry sibling result was adopted");
      }
    } finally {
      Date.now = realNow;
    }
  });
});

/* ------------------------------------------------------------------- 80-83 */

test("80 broadcast payload carries tenantId, accessToken, expiresAt; tokenless omits accessToken and only advances expiry", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    const h = hub();
    const srv = bff((_c, n) => okToken(n));
    const a = manager(srv.fetch, h.make());
    await a.refresh("t1");
    const m = h.posted.find((x) => x.type === "token_refreshed") as any;
    assert.equal(m.tenantId, "t1");
    assert.equal(m.accessToken, "at-1");
    assert.equal(typeof m.expiresAt, "number");

    // tokenless: /token returns only expiresAt
    const h2 = hub();
    const exp = Date.now() + 7_200_000;
    const srv2 = bff(() => ({ status: 200, body: { expiresAt: exp } }));
    const ta = manager(srv2.fetch, h2.make(), { tokenless: true });
    const tb = manager(srv2.fetch, h2.make(), { tokenless: true });
    ta.set("t1", "opaque", 100);
    tb.set("t1", "opaque", 100);
    await ta.refresh("t1");
    const m2 = h2.posted.find((x) => x.type === "token_refreshed") as any;
    assert.equal("accessToken" in m2, false, "tokenless broadcast carried a token");
    assert.equal(tb.peek("t1"), "opaque");
    assert.ok((tb.peekExpiresAt("t1") ?? 0) >= exp - 1000, "receiver did not advance the expiry");
  });
});

test("81 BroadcastChannel absent -> storage fallback message has NO accessToken; localStorage never holds a token", async () => {
  const g = globalThis as any;
  const saved = { window: g.window, localStorage: g.localStorage, BC: g.BroadcastChannel };
  const store = new Map<string, string>();
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.localStorage = {
    setItem: (k: string, v: string) => store.set(k, v),
    getItem: (k: string) => store.get(k) ?? null,
  };
  delete g.BroadcastChannel;
  try {
    const bus = createTabBus(CHANNEL);
    bus.post({ type: "token_refreshed", tenantId: "t1", accessToken: "SECRET-TOKEN", expiresAt: 123 });
    assert.ok(store.size > 0, "nothing was written to the storage fallback");
    for (const [k, v] of store) {
      assert.ok(!v.includes("SECRET-TOKEN"), `localStorage[${k}] holds a token`);
    }
    const written = JSON.parse([...store.values()][0]);
    assert.equal(written.msg.type, "token_refreshed");
    assert.equal(written.msg.tenantId, "t1");
    bus.close();
  } finally {
    g.window = saved.window;
    g.localStorage = saved.localStorage;
    g.BroadcastChannel = saved.BC;
    if (saved.window === undefined) delete g.window;
    if (saved.localStorage === undefined) delete g.localStorage;
  }
});

test("82 navigator.locks absent -> no throw; single-flight is per-BFF (two tenants in one tab serialized)", async () => {
  await withNavigator({}, async () => {
    const srv = bff((_c, n) => okToken(n));
    const a = manager(srv.fetch, hub().make());
    await Promise.all([a.refresh("t1"), a.refresh("t2")]);
    assert.equal(srv.tokenCalls().length, 2);
    assert.equal(srv.maxInflight(), 1, "without Web Locks the two tenants still overlapped");
  });
});

test("83 a broadcast token is adopted only when its expiry is later than the held one", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    const h = hub();
    const srv = bff((_c, n) => okToken(n));
    const sibling = h.make();
    const b = manager(srv.fetch, h.make());
    b.set("t1", "held", 3600);
    const heldExp = b.peekExpiresAt("t1")!;
    // ignore branch
    sibling.post({ type: "token_refreshed", tenantId: "t1", accessToken: "earlier", expiresAt: heldExp - 10_000 });
    assert.equal(b.peek("t1"), "held");
    // adopt branch
    sibling.post({ type: "token_refreshed", tenantId: "t1", accessToken: "later", expiresAt: heldExp + 10_000 });
    assert.equal(b.peek("t1"), "later");
    assert.equal(b.peekExpiresAt("t1"), heldExp + 10_000);
  });
});

/* -------------------------------------------------------------------- 84 */

test("84 logout() sends the held access token as Bearer; none when none held; tolerates 401/404", async () => {
  const mk = (status: number) => {
    const srv = bff((c) => (c.url.endsWith("/logout") ? { status } : { status: 404 }));
    const realm = createRealm({ baseUrl: "https://bff.test", fetch: srv.fetch, autoRestore: false });
    return { srv, realm };
  };
  {
    const { srv, realm } = mk(200);
    realm.adopt({ accessToken: "held-token", expiresIn: 3600, tenantId: "t1", user: { id: "u" } as any });
    await realm.logout();
    const c = srv.calls.find((x) => x.url.endsWith("/logout"))!;
    assert.equal(c.headers["authorization"], "Bearer held-token");
    realm.close();
  }
  {
    const { srv, realm } = mk(401);
    await realm.logout(); // no token held, 401 tolerated
    const c = srv.calls.find((x) => x.url.endsWith("/logout"))!;
    assert.equal(c.headers["authorization"], undefined);
    realm.close();
  }
  {
    const { realm } = mk(404);
    realm.adopt({ accessToken: "t", expiresIn: 3600, tenantId: "t1", user: { id: "u" } as any });
    await realm.logout(); // 404 tolerated
    realm.close();
  }
});

/* ------------------------------------------------------------------ 85-87 */

test("85 exclusive: after /token for Y, other tenants' tokens are dropped and tenant_switched{Y} is broadcast besides token_refreshed", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    const h = hub();
    const srv = bff((_c, n) => okToken(n, { org_session_mode: "exclusive" }));
    const a = manager(srv.fetch, h.make());
    a.set("x", "tok-x", 3600);
    a.set("y", "old-y", 30);
    await a.refresh("y");
    assert.equal(a.peek("x"), undefined, "the other tenant's token survived an exclusive refresh");
    assert.equal(a.peek("y"), "at-1");
    const types = h.posted.map((m) => m.type);
    assert.ok(types.includes("token_refreshed"));
    const sw = h.posted.find((m) => m.type === "tenant_switched") as any;
    assert.equal(sw?.tenantId, "y");
  });
});

test("86 exclusive: a receiving tab drops its other-tenant tokens and does NOT refresh its old tenant (no ping-pong)", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    const h = hub();
    const srv = bff((_c, n) => okToken(n, { org_session_mode: "exclusive" }));
    const a = manager(srv.fetch, h.make());
    const b = manager(srv.fetch, h.make());
    // both tabs have learned the mode from an earlier refresh and hold X
    a.set("x", "ax", 3600);
    b.set("x", "bx", 3600);
    await a.refresh("x"); // /token #1 (learns mode; b adopts)
    await b.refresh("x"); // adopted from broadcast inside the lock window: no new call
    const before = srv.tokenCalls().length;
    await a.refresh("y"); // tab A moves to Y
    assert.equal(srv.tokenCalls().length, before + 1);
    assert.equal(b.peek("x"), undefined, "tab B kept the old org's token");
    assert.equal(b.peek("y"), "at-" + (before + 1), "tab B did not adopt Y's token");
    b.setCurrentTenant("y");
    await b.get("y");
    assert.equal(srv.tokenCalls().length, before + 1, "tab B refreshed instead of following");
  });
});

test("87 concurrent (and absent): nothing dropped, no tenant_switched", async () => {
  for (const extra of [{ org_session_mode: "concurrent" }, {}]) {
    await withNavigator({ locks: mockLocks() }, async () => {
      const h = hub();
      const srv = bff((_c, n) => okToken(n, extra));
      const a = manager(srv.fetch, h.make());
      a.set("x", "tok-x", 3600);
      a.set("y", "old-y", 30);
      await a.refresh("y");
      assert.equal(a.peek("x"), "tok-x");
      assert.equal(h.posted.some((m) => m.type === "tenant_switched"), false);
    });
  }
});

/* ---------------------------------------------------------------- 88-88b */

function churnBff() {
  let latest = "tok-boot";
  let n = 0;
  const srv = bff((c) => {
    if (c.url.endsWith("/token")) {
      n++;
      latest = `tok-${n}`;
      return { status: 200, body: { accessToken: latest, expiresIn: 3600 } };
    }
    if (c.url.includes("/api/")) {
      const bearer = c.headers["authorization"]?.replace("Bearer ", "");
      if (bearer !== latest) {
        return { status: 401, body: { error: { code: "unauthorized", message: "token superseded" }, revoked: true } };
      }
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });
  return srv;
}

test("88 a tab that gets 401 revoked:true with no broadcast refreshes once and succeeds", async () => {
  const srv = churnBff();
  const realm = createRealm({ baseUrl: "https://bff.test", fetch: srv.fetch, autoRestore: false });
  realm.adopt({ accessToken: "tok-stale", expiresIn: 3600, tenantId: "t1", user: { id: "u" } as any });
  const res = await realm.fetch("https://api.test/api/x");
  assert.equal(res.status, 200);
  assert.equal(srv.tokenCalls().length, 1);
  assert.equal(realm.getState().status, "authenticated");
  realm.close();
});

test("88a H2 churn: two realms, no BroadcastChannel, alternating -> 401 + /token + retry each; onLost/logout NEVER", async () => {
  const srv = churnBff();
  const mk = () => {
    const r = createRealm({ baseUrl: "https://bff.test", fetch: srv.fetch, autoRestore: false });
    r.adopt({ accessToken: "tok-0", expiresIn: 3600, tenantId: "t1", user: { id: "u" } as any });
    return r;
  };
  const a = mk();
  const b = mk();
  const events: string[] = [];
  a.onAuthChange((e) => events.push(e.type));
  b.onAuthChange((e) => events.push(e.type));
  const order = [a, b, a, b, a];
  let expectTokenCalls = 0;
  for (let i = 0; i < order.length; i++) {
    const res = await order[i].fetch("https://api.test/api/x");
    assert.equal(res.status, 200, `switch ${i} did not recover`);
    expectTokenCalls += 1; // every switch: one 401, one /token, one retry
    assert.equal(srv.tokenCalls().length, expectTokenCalls, `switch ${i}: wrong number of /token calls`);
  }
  assert.equal(events.includes("logout"), false, "a churn 401 signed someone out");
  assert.equal(a.getState().status, "authenticated");
  assert.equal(b.getState().status, "authenticated");
  a.close();
  b.close();
});

test("88b /token 503 retry:true carrying refresh_token -> adopted, retried ONCE in the same lock; a second 503 fails as server_error, onLost silent", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    let lost = 0;
    // first: 503 then success
    {
      let k = 0;
      const srv = bff(() => {
        k++;
        if (k === 1) {
          return {
            status: 503,
            body: { error: { code: "server_error", message: "refresh superseded, retry" }, retry: true, refresh_token: "R2" },
          };
        }
        return okToken(7);
      });
      const a = manager(srv.fetch, hub().make(), { onLost: () => lost++ });
      const tok = await a.refresh("t1");
      assert.equal(tok, "at-7");
      assert.equal(srv.tokenCalls().length, 2);
      assert.equal(srv.tokenCalls()[1].body.refreshToken, "R2", "the retry did not carry the adopted refresh token");
      assert.equal(srv.tokenCalls()[1].body.refresh_token, "R2", "the retry did not carry refresh_token (snake): a snake-case reader would re-present the spent token");
    }
    // second 503 is a failed refresh, not a lost session
    {
      const srv = bff(() => ({
        status: 503,
        body: { error: { code: "server_error", message: "refresh superseded, retry" }, retry: true, refresh_token: "R3" },
      }));
      const a = manager(srv.fetch, hub().make(), { onLost: () => lost++ });
      await assert.rejects(a.refresh("t1"), (e: unknown) => e instanceof RealmError && e.code === "server_error");
      assert.equal(srv.tokenCalls().length, 2, "retried more than once");
    }
    assert.equal(lost, 0, "onLost fired on a 503");
  });
});

test("88c 503 retry overrides a snake-case refresh_token already in an adapter-built body (never re-presents the spent token)", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    let k = 0;
    const srv = bff(() => {
      k++;
      if (k === 1) {
        return { status: 503, body: { error: { code: "server_error", message: "x" }, retry: true, refresh_token: "R2" } };
      }
      return okToken(7);
    });
    const a = manager(srv.fetch, hub().make(), {
      requestAdapters: { token: () => ({ refresh_token: "SPENT" }) },
    } as any);
    await a.refresh("t1");
    const b = srv.tokenCalls()[1].body;
    assert.equal(b.refresh_token, "R2");
    assert.equal(b.refreshToken, "R2");
  });
});

test("89 logout({all:true}) sends all:true; plain logout() still sends {} (old BFF unaffected)", async () => {
  const srv = bff((c) => (c.url.endsWith("/logout") ? { status: 200 } : { status: 404 }));
  const realm = createRealm({ baseUrl: "https://bff.test", fetch: srv.fetch, autoRestore: false });
  await realm.logout({ all: true });
  assert.deepEqual(srv.calls.find((x) => x.url.endsWith("/logout"))!.body, { all: true });
  await realm.logout();
  const logouts = srv.calls.filter((x) => x.url.endsWith("/logout"));
  assert.deepEqual(logouts[1].body, {});
  realm.close();
});

test("90 against an OLD backend: a plain 200 /token with no org_session_mode refreshes as concurrent, one call", async () => {
  await withNavigator({ locks: mockLocks() }, async () => {
    const srv = bff(() => okToken(5));
    const a = manager(srv.fetch, hub().make(), {});
    assert.equal(await a.refresh("t1"), "at-5");
    assert.equal(srv.tokenCalls().length, 1);
  });
});
