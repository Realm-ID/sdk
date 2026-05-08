/**
 * Core integration tests — drive the Realm against a mocked fetch
 * implementing the BFF contract. Verifies token mgmt, refresh dedupe,
 * 401 replay, tenant switch, logout, multi-tab sync.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRealm, RealmError } from "./index.js";

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
  const { fetch } = mockFetch((call) => {
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
