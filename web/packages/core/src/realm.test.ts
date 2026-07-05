/**
 * Core integration tests — drive the Realm against a mocked fetch
 * implementing the BFF contract. Verifies token mgmt, refresh dedupe,
 * 401 replay, tenant switch, logout, multi-tab sync.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRealm,
  RealmError,
  memoryStorage,
  localStorageAdapter,
  DEFAULT_STORAGE_KEY,
  type StoredSession,
} from "./index.js";

interface MockCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function mockFetch(handler: (call: MockCall) => { status: number; body?: unknown }) {
  const calls: MockCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url, method, body, headers };
    calls.push(call);
    const { status, body: respBody } = handler(call);
    return new Response(respBody !== undefined ? JSON.stringify(respBody) : null, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fn, calls };
}

test("login wires user/tenants/state and access token", async () => {
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401, body: { message: "unauthorized" } };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-1",
          expiresIn: 3600,
          user: { id: "u1", email: "u@x" },
          tenants: [{ id: "t1", role: "owner" }],
          defaultTenantId: "t1",
        },
      };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();

  assert.equal(realm.getState().status, "anonymous");
  await realm.login({ method: "google", providerToken: "id-1" });
  const s = realm.getState();
  assert.equal(s.status, "authenticated");
  assert.equal(s.user?.id, "u1");
  assert.equal(s.currentTenantId, "t1");
  assert.equal(calls.find((c) => c.url.endsWith("/login"))?.body && (calls.find((c) => c.url.endsWith("/login"))!.body as { method: string }).method, "google");
  realm.close();
});

test("realm.fetch attaches access token, refreshes on 401, replays once", async () => {
  let firstCall = true;
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-1",
          expiresIn: 3600,
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
          defaultTenantId: "t1",
        },
      };
    }
    if (call.url.endsWith("/token")) {
      return { status: 200, body: { accessToken: "at-2", expiresIn: 3600 } };
    }
    if (call.url.includes("/api/orders")) {
      if (firstCall) {
        firstCall = false;
        return { status: 401, body: { error: { message: "expired" } } };
      }
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });

  const res = await realm.fetch("https://api.test/api/orders");
  assert.equal(res.status, 200);

  const orderCalls = calls.filter((c) => c.url.includes("/api/orders"));
  assert.equal(orderCalls.length, 2);
  assert.equal(orderCalls[0].headers["authorization"], "Bearer at-1");
  assert.equal(orderCalls[1].headers["authorization"], "Bearer at-2");
  realm.close();
});

test("concurrent fetches share one refresh", async () => {
  let refreshCount = 0;
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-1",
          expiresIn: 3600,
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
          defaultTenantId: "t1",
        },
      };
    }
    if (call.url.endsWith("/token")) {
      refreshCount++;
      return { status: 200, body: { accessToken: `at-${refreshCount + 1}`, expiresIn: 3600 } };
    }
    if (call.url.includes("/api/")) {
      const auth = call.headers["authorization"];
      if (auth === "Bearer at-1") return { status: 401, body: { error: { message: "expired" } } };
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });

  // Fire 5 concurrent calls — they should share one refresh.
  const results = await Promise.all([
    realm.fetch("https://api.test/api/a"),
    realm.fetch("https://api.test/api/b"),
    realm.fetch("https://api.test/api/c"),
    realm.fetch("https://api.test/api/d"),
    realm.fetch("https://api.test/api/e"),
  ]);
  for (const r of results) assert.equal(r.status, 200);
  assert.equal(refreshCount, 1, "exactly one /token refresh");
  void calls;
  realm.close();
});

test("switchTenant mints a new token and updates state", async () => {
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-1",
          expiresIn: 3600,
          user: { id: "u1" },
          tenants: [
            { id: "t1", role: "owner" },
            { id: "t2", role: "member" },
          ],
          defaultTenantId: "t1",
        },
      };
    }
    if (call.url.endsWith("/switch-tenant")) {
      return { status: 200, body: { accessToken: "at-t2", expiresIn: 3600 } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });
  await realm.switchTenant("t2");
  assert.equal(realm.getState().currentTenantId, "t2");
  // The switch must carry the current bearer — a BFF that re-pins server-side
  // loads the session from it (regression: anonymous switch → 401).
  const switchCall = calls.find((c) => c.url.endsWith("/switch-tenant"));
  assert.equal(switchCall?.headers["authorization"], "Bearer at-1", "switch attaches current bearer");
  realm.close();
});

test("switchTenant rejects unknown tenant", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-1",
          expiresIn: 3600,
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
          defaultTenantId: "t1",
        },
      };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });
  await assert.rejects(() => realm.switchTenant("t-nope"), (e) => e instanceof RealmError && e.code === "tenant_not_found");
  realm.close();
});

test("resolveTenant re-submits the SAME provider token with the chosen tenant (no second redirect)", async () => {
  // Reproduces the Microsoft double-round-trip: a provider login gated on
  // tenants_required must be completed by re-sending the retained id_token with
  // the picked tenant — NOT by re-running signIn (a fresh OIDC redirect).
  let loginHits = 0;
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      loginHits += 1;
      const b = call.body as { tenantId?: string };
      if (!b.tenantId) {
        // First hop: no tenant → tenant picker gate.
        return {
          status: 200,
          body: {
            tenantsRequired: true,
            tenants: [
              { id: "t1", role: "owner" },
              { id: "t2", role: "member" },
            ],
          },
        };
      }
      // Second hop: tenant chosen → session issued.
      return {
        status: 200,
        body: {
          accessToken: "at-picked",
          expiresIn: 3600,
          user: { id: "u1", email: "u@x" },
          tenants: [{ id: b.tenantId, role: "member" }],
          defaultTenantId: b.tenantId,
        },
      };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();

  await assert.rejects(
    () => realm.login({ method: "microsoft", providerToken: "ms-id-token" }),
    (e) => e instanceof RealmError && e.code === "tenants_required",
  );

  // Resolve the gate — this must NOT touch signIn/OIDC; it just re-POSTs /login.
  await realm.resolveTenant("t2");

  const s = realm.getState();
  assert.equal(s.status, "authenticated");
  assert.equal(s.currentTenantId, "t2");
  assert.equal(loginHits, 2, "exactly two /login calls — one gated, one resolved");

  const second = calls.filter((c) => c.url.endsWith("/login"))[1]!.body as {
    method: string;
    providerToken: string;
    tenantId: string;
  };
  assert.equal(second.method, "microsoft");
  assert.equal(second.providerToken, "ms-id-token", "reuses the SAME token, no re-auth");
  assert.equal(second.tenantId, "t2");

  // Token is single-use: a second resolve has nothing retained.
  await assert.rejects(
    () => realm.resolveTenant("t1"),
    (e) => e instanceof RealmError && e.code === "no_pending_login",
  );
  realm.close();
});

test("resolveTenant without a pending provider login throws no_pending_login", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await assert.rejects(
    () => realm.resolveTenant("t1"),
    (e) => e instanceof RealmError && e.code === "no_pending_login",
  );
  realm.close();
});

test("logout clears state and fires event", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-1",
          expiresIn: 3600,
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
          defaultTenantId: "t1",
        },
      };
    }
    if (call.url.endsWith("/logout")) return { status: 204 };
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });

  const events: string[] = [];
  realm.onAuthChange((ev) => events.push(ev.type));
  await realm.logout();

  assert.equal(realm.getState().status, "anonymous");
  assert.ok(events.includes("logout"));
  realm.close();
});

test("restore on construction populates state from /me", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) {
      return {
        status: 200,
        body: {
          user: { id: "u1", email: "u@x" },
          tenants: [{ id: "t1", role: "owner" }],
          currentTenantId: "t1",
        },
      };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  assert.equal(realm.getState().status, "authenticated");
  assert.equal(realm.getState().user?.id, "u1");
  realm.close();
});

test("providers passes tenant_id query", async () => {
  const seen: string[] = [];
  const { fetch } = mockFetch((call) => {
    if (call.url.includes("/providers")) {
      seen.push(call.url);
      return { status: 200, body: { providers: [], signupMode: "open" } };
    }
    if (call.url.endsWith("/me")) return { status: 401 };
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.providers({ tenantId: "t1" });
  assert.ok(seen[0]?.includes("tenant_id=t1"));
  realm.close();
});

test("storage: pre-seeded entry paints authenticated synchronously and stays after /me revalidates", async () => {
  const storage = memoryStorage();
  const seed: StoredSession = {
    accessToken: "at-stored",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    tenantId: "t1",
    user: { id: "u1", email: "u@x" },
    tenants: [{ id: "t1", role: "owner" }],
  };
  storage.write(seed);

  let meResolve: (() => void) | null = null;
  const meGate = new Promise<void>((r) => {
    meResolve = r;
  });

  const { fetch } = mockFetch((call) => {
    void call;
    return { status: 200, body: { user: { id: "u1" }, tenants: [{ id: "t1", role: "owner" }], currentTenantId: "t1" } };
  });
  // Wrap fetch so /me suspends until we release the gate.
  const fetchGated: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    if (url.endsWith("/me")) await meGate;
    return fetch(input, init);
  };

  const realm = createRealm({ baseUrl: "https://bff.test", fetch: fetchGated, storage });
  // Pre-/me: state is already authenticated.
  assert.equal(realm.getState().status, "authenticated");
  assert.equal(realm.getState().user?.id, "u1");
  meResolve!();
  await realm.ready();
  assert.equal(realm.getState().status, "authenticated");
  realm.close();
});

test("storage: pre-seeded entry but /me 401 drops to anonymous and clears storage", async () => {
  const storage = memoryStorage();
  storage.write({
    accessToken: "at-stale",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    tenantId: "t1",
    user: { id: "u1" },
    tenants: [{ id: "t1", role: "owner" }],
  });

  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401, body: { message: "unauthorized" } };
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch, storage });
  await realm.ready();
  assert.equal(realm.getState().status, "anonymous");
  assert.equal(storage.read(), null);
  realm.close();
});

test("storage: restore()'s /me revalidation attaches the session bearer (BFF requires it)", async () => {
  const storage = memoryStorage();
  // FRESH snapshot — not expired. The stored accessToken IS the opaque BFF
  // session bearer (rsid_…, durable ~30d, rotated server-side). On restore the
  // SDK must forward it on the /me revalidation, exactly like the reference BFF
  // demands (loadSession → 401 session_missing when the Authorization bearer is
  // absent). Reproduces the reload sign-out: bearerless /me → session_missing →
  // restore() drops to anonymous (RCA 2026-07-01).
  storage.write({
    accessToken: "rsid_durable",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    tenantId: "t1",
    user: { id: "u1", email: "u@x" },
    tenants: [{ id: "t1", role: "owner" }],
  });

  const meCalls: { hadBearer: boolean }[] = [];
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) {
      const auth = call.headers["authorization"];
      meCalls.push({ hadBearer: !!auth });
      if (!auth) return { status: 401, body: { error: { code: "session_missing", message: "missing session bearer" } } };
      return { status: 200, body: { user: { id: "u1" }, tenants: [{ id: "t1", role: "owner" }], currentTenantId: "t1" } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch, storage });
  await realm.ready();
  // The revalidation must have carried the bearer, and the session must survive.
  assert.ok(meCalls.length > 0, "restore() should call /me");
  assert.ok(meCalls.every((c) => c.hadBearer), "restore()'s /me must send the session bearer");
  assert.equal(realm.getState().status, "authenticated");
  assert.equal(realm.getState().currentTenantId, "t1");
  realm.close();
});

test("storage: tokenless reload >15m after mint keeps the durable session (does not discard on access-TTL)", async () => {
  const storage = memoryStorage();
  // Snapshot's expiresAt is the ~15m access-JWT hint and is already PAST — but
  // under tokenless (BFF) rotation the accessToken is the durable session
  // bearer. The SDK must adopt it and re-validate via an authenticated /me,
  // NOT discard it and sign the user out (RCA 2026-07-01, the reported bug).
  storage.write({
    accessToken: "rsid_durable",
    expiresAt: Math.floor(Date.now() / 1000) - 60, // access-TTL expired
    tenantId: "t1",
    user: { id: "u1", email: "u@x" },
    tenants: [{ id: "t1", role: "owner" }],
  });

  let meWithBearer = 0;
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) {
      if (!call.headers["authorization"])
        return { status: 401, body: { error: { code: "session_missing", message: "missing session bearer" } } };
      meWithBearer++;
      return { status: 200, body: { user: { id: "u1" }, tenants: [{ id: "t1", role: "owner" }], currentTenantId: "t1" } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch, storage, refresh: { tokenless: true, sendBearer: true } });
  await realm.ready();
  assert.ok(meWithBearer > 0, "an authenticated /me must have re-validated the durable session");
  assert.equal(realm.getState().status, "authenticated");
  assert.equal(realm.getState().currentTenantId, "t1");
  assert.ok(storage.read(), "the session snapshot must survive the reload");
  realm.close();
});

test("storage: login writes a session entry", async () => {
  const storage = memoryStorage();
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-1",
          expiresIn: 3600,
          user: { id: "u1", email: "u@x" },
          tenants: [{ id: "t1", role: "owner" }],
          defaultTenantId: "t1",
        },
      };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch, storage });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });

  const stored = storage.read();
  assert.ok(stored);
  assert.equal(stored!.accessToken, "at-1");
  assert.equal(stored!.tenantId, "t1");
  assert.equal(stored!.user?.id, "u1");
  assert.ok(stored!.expiresAt > Math.floor(Date.now() / 1000));
  realm.close();
});

test("storage: logout clears the entry", async () => {
  const storage = memoryStorage();
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-1",
          expiresIn: 3600,
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
          defaultTenantId: "t1",
        },
      };
    }
    if (call.url.endsWith("/logout")) return { status: 204 };
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch, storage });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "x" });
  assert.ok(storage.read());
  await realm.logout();
  assert.equal(storage.read(), null);
  realm.close();
});

test("storage: localStorageAdapter pre-seed survives constructor", async () => {
  // Hand-rolled localStorage on globalThis so the adapter sees it.
  const store = new Map<string, string>();
  const api: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  const seed: StoredSession = {
    accessToken: "at-stored",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    tenantId: "t1",
    user: { id: "u1", email: "u@x" },
    tenants: [{ id: "t1", role: "owner" }],
  };
  store.set(DEFAULT_STORAGE_KEY, JSON.stringify(seed));
  const g = globalThis as unknown as { localStorage?: Storage };
  const prev = g.localStorage;
  g.localStorage = api;
  try {
    const { fetch } = mockFetch((call) => {
      if (call.url.endsWith("/me")) {
        return { status: 200, body: { user: { id: "u1" }, tenants: [{ id: "t1", role: "owner" }], currentTenantId: "t1" } };
      }
      return { status: 404 };
    });
    const realm = createRealm({ baseUrl: "https://bff.test", fetch, storage: localStorageAdapter() });
    assert.equal(realm.getState().status, "authenticated");
    await realm.ready();
    assert.equal(realm.getState().status, "authenticated");
    realm.close();
  } finally {
    if (prev === undefined) delete g.localStorage;
    else g.localStorage = prev;
  }
});

test("envelope unwrap strips { data: ... } single-key wrappers", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) {
      return {
        status: 200,
        body: { data: { user: { id: "u1" }, tenants: [{ id: "t1", role: "owner" }], currentTenantId: "t1" } },
      };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  assert.equal(realm.getState().user?.id, "u1");
  realm.close();
});
