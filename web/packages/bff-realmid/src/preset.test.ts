/**
 * End-to-end test of the realmid-bff preset against a mock that mirrors
 * the realmid.dev BFF wire shape (snake_case, status-discriminated login,
 * 412 gates, tokenless /token rotation, flat /me).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRealm, RealmError } from "@realm-id/web";
import { realmidBffPreset } from "./index.js";

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
    const res = handler(call);
    return new Response(res.body !== undefined ? JSON.stringify(res.body) : null, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch: fn, calls };
}

test("realmid preset: request adapter rewrites /login body to snake_case", async () => {
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          status: "ok",
          session_token: "sid-1",
          expires_at: Math.floor((Date.now() + 3600_000) / 1000),
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
        },
      };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "g-id", tenantId: "t1" });
  const loginBody = calls.find((c) => c.url.endsWith("/login"))!.body as Record<string, unknown>;
  // ADR-051: provider login speaks grant_type + provider, NOT the legacy `method`.
  assert.equal(loginBody.grant_type, "provider_token", "grant_type=provider_token");
  assert.equal(loginBody.provider, "google", "provider names the IdP");
  assert.equal(loginBody.method, undefined, "no deprecated `method` field on the wire");
  assert.equal(loginBody.token, "g-id", "providerToken → token");
  assert.equal(loginBody.tenant_id, "t1", "tenantId → tenant_id");
  assert.equal(loginBody.providerToken, undefined, "no camelCase leakage");
  assert.equal(loginBody.tenantId, undefined, "no camelCase leakage");
  realm.close();
});

// ADR-051 (2026-07-05): Microsoft login must send grant_type=provider_token +
// provider=microsoft. Regression guard for the bug where the web SDK rode the
// deprecated `method` field, which the issuer's compat shim didn't map for
// microsoft → `grant_type is required`. Migrating the wire removes that
// dependency entirely (and lets the issuer drop the shim at Sunset 2026-08-01).
test("realmid preset: microsoft login sends grant_type=provider_token + provider", async () => {
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          status: "ok",
          session_token: "sid-1",
          expires_at: Math.floor((Date.now() + 3600_000) / 1000),
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
        },
      };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  await realm.login({ method: "microsoft", providerToken: "ms-id-token", tenantId: "t1" });
  const body = calls.find((c) => c.url.endsWith("/login"))!.body as Record<string, unknown>;
  assert.equal(body.grant_type, "provider_token");
  assert.equal(body.provider, "microsoft");
  assert.equal(body.method, undefined, "no deprecated `method` field");
  assert.equal(body.token, "ms-id-token");
  realm.close();
});

test("realmid preset: full login → /me → tokenless refresh round-trip", async () => {
  const future = () => Math.floor((Date.now() + 3600_000) / 1000);
  const nearFuture = () => Math.floor((Date.now() + 1000) / 1000);

  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          status: "ok",
          session_token: "sid-1",
          expires_at: nearFuture(),
          realm_id: "r1",
          user: { id: "u1", email: "u@x", display_name: "User" },
          tenants: [{ id: "t1", role: "owner", display_name: "Acme" }],
        },
      };
    }
    if (call.url.endsWith("/token")) {
      return { status: 200, body: { expires_at: future() } };
    }
    if (call.url.includes("/api/orders")) {
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "g" });

  const s = realm.getState();
  assert.equal(s.status, "authenticated");
  assert.equal(s.user?.id, "u1");
  assert.equal(s.user?.displayName, "User");
  assert.equal(s.currentTenantId, "t1");
  assert.equal(s.tenants[0]?.displayName, "Acme");

  const res = await realm.fetch("https://api.test/api/orders");
  assert.equal(res.status, 200);

  // Token rotation kept the same bearer.
  const apiCall = calls.find((c) => c.url.includes("/api/orders"))!;
  assert.equal(apiCall.headers["authorization"], "Bearer sid-1");
  const tokenCall = calls.find((c) => c.url.endsWith("/token"))!;
  assert.equal(tokenCall.headers["authorization"], "Bearer sid-1");
  realm.close();
});

test("realmid preset: 412 mfa_required surfaces challengeToken via gate", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 412,
        body: { code: "mfa_required", mfa_challenge_token: "ch-1", method: "totp" },
      };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  await assert.rejects(
    () => realm.login({ method: "google", providerToken: "g" }),
    (e) => {
      if (!(e instanceof RealmError)) return false;
      if (e.code !== "mfa_required") return false;
      const body = e.body as { challengeToken?: string };
      return body.challengeToken === "ch-1";
    },
  );
  realm.close();
});

test("realmid preset: 412 session_limit_reached gate exposes revocation_token", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 412,
        body: {
          code: "session_limit_reached",
          revocation_token: "rev-1",
          sessions: [{ id: "s1" }, { id: "s2" }],
        },
      };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  let captured: RealmError | null = null;
  try {
    await realm.login({ method: "google", providerToken: "g" });
  } catch (e) {
    captured = e as RealmError;
  }
  assert.ok(captured && captured.code === "session_limit_reached");
  const body = captured.body as { revocationToken?: string; sessions?: unknown[] };
  assert.equal(body.revocationToken, "rev-1");
  assert.equal(body.sessions?.length, 2);
  realm.close();
});

test("realmid preset: tenants_required gate populates pendingTenants", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          status: "tenants_required",
          tenants: [
            { id: "t1", role: "owner", display_name: "Acme" },
            { id: "t2", role: "member", display_name: "Beta" },
          ],
          realm_id: "r1",
        },
      };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  await assert.rejects(
    () => realm.login({ method: "google", providerToken: "g" }),
    (e) => e instanceof RealmError && e.code === "tenants_required",
  );
  const pending = realm.getState().pendingTenants;
  assert.equal(pending?.length, 2);
  assert.equal(pending?.[0]?.displayName, "Acme");
  realm.close();
});

test("realmid preset: /me restore populates from flat snake_case shape", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) {
      return {
        status: 200,
        body: {
          user_id: "u1",
          realm_id: "r1",
          tenant_id: "t1",
          role: "owner",
          email: "u@x",
          display_name: "User",
          expires_at: Math.floor((Date.now() + 3600_000) / 1000),
        },
      };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  const s = realm.getState();
  assert.equal(s.status, "authenticated");
  assert.equal(s.user?.id, "u1");
  assert.equal(s.user?.email, "u@x");
  assert.equal(s.currentTenantId, "t1");
  realm.close();
});

test("realmid preset: /me restore populates the full switchable set from memberships[]", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) {
      return {
        status: 200,
        body: {
          user_id: "u1",
          realm_id: "r1",
          // current pinned tenant (injected by the BFF from the session record)
          tenant_id: "t1",
          role: "owner",
          email: "u@x",
          display_name: "User",
          memberships: [
            { tenant_id: "t1", display_name: "Acme", role: "owner" },
            { tenant_id: "t2", display_name: "Globex", role: "member" },
          ],
          expires_at: Math.floor((Date.now() + 3600_000) / 1000),
        },
      };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  const s = realm.getState();
  assert.equal(s.status, "authenticated");
  assert.equal(s.currentTenantId, "t1", "current tenant from tenant_id, not memberships[0]");
  assert.equal(s.tenants.length, 2, "full membership set surfaces for the switcher");
  assert.deepEqual(
    s.tenants.map((t) => t.id).sort(),
    ["t1", "t2"],
  );
  assert.equal(s.tenants.find((t) => t.id === "t2")?.displayName, "Globex");
  realm.close();
});

test("realmid preset: switchTenant re-pins via POST /switch-tenant (no re-login)", async () => {
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) {
      return {
        status: 200,
        body: {
          user_id: "u1",
          tenant_id: "t1",
          role: "owner",
          memberships: [
            { tenant_id: "t1", display_name: "Acme", role: "owner" },
            { tenant_id: "t2", display_name: "Globex", role: "member" },
          ],
          expires_at: Math.floor((Date.now() + 3600_000) / 1000),
        },
      };
    }
    if (call.url.endsWith("/switch-tenant")) {
      // BFF re-pins server-side; session_token unchanged, only expiry advances.
      return { status: 200, body: { expires_at: Math.floor((Date.now() + 3600_000) / 1000) } };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  await realm.switchTenant("t2");
  const switchCall = calls.find((c) => c.url.endsWith("/switch-tenant"));
  assert.ok(switchCall, "hit /switch-tenant, not /login");
  assert.equal(switchCall!.method, "POST");
  assert.deepEqual(switchCall!.body, { tenant_id: "t2" }, "tenantId → tenant_id");
  assert.equal(realm.getState().currentTenantId, "t2");
  assert.equal(calls.filter((c) => c.url.endsWith("/login")).length, 0, "no re-login round-trip");
  realm.close();
});

test("realmid preset: providers query uses platform=", async () => {
  const seen: string[] = [];
  const { fetch } = mockFetch((call) => {
    if (call.url.includes("/identity-providers")) {
      seen.push(call.url);
      return {
        status: 200,
        body: {
          providers: [
            { id: "p1", provider: "google", client_type: "web", client_id: "abc", enabled: true },
          ],
          signup_mode: "open",
        },
      };
    }
    if (call.url.endsWith("/me")) return { status: 401 };
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  const out = await realm.providers({ clientType: "web" });
  assert.ok(seen[0]?.includes("platform=web"), "uses 'platform' query param");
  assert.equal(out.providers[0]?.clientId, "abc");
  assert.equal(out.signupMode, "open");
  realm.close();
});

// Regression (2026-07-05): the BFF's public providers response names the
// provider field `type` (e.g. {"type":"microsoft"}), not `provider`. The
// adapter must read `type` so `resolveProvider` (used by the OIDC signIn path,
// i.e. Microsoft) can find the row — otherwise `provider` maps to "" and
// signIn throws `no <type> provider configured for this realm`. Google/Firebase
// never hit this path, so it stayed latent until the first Microsoft login.
test("realmid preset: providers adapter maps wire `type` → `provider`", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.includes("/identity-providers")) {
      return {
        status: 200,
        body: {
          // Real wire shape from the BFF/issuer: `type`, no `provider`.
          providers: [{ type: "microsoft", client_type: "web", client_id: "5076b28d" }],
        },
      };
    }
    if (call.url.endsWith("/me")) return { status: 401 };
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, ...realmidBffPreset() });
  await realm.ready();
  const out = await realm.providers({ clientType: "web" });
  assert.equal(out.providers[0]?.provider, "microsoft", "wire `type` must map to `provider`");
  assert.equal(out.providers[0]?.clientId, "5076b28d");
  realm.close();
});
