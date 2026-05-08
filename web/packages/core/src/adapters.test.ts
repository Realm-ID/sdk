/**
 * Tests for the v0.2 surface: response adapters, gates, tokenless refresh,
 * switch-tenant fallback, CSRF injection, expiresAt-only schedules, and the
 * tenants_required gate. Each test sets up a partner-flavoured mock BFF
 * (snake_case wire shape, 412 gates, etc.) and verifies the SDK normalises
 * it into the canonical state machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRealm, RealmError } from "./index.js";
import type { ResponseAdapters, GateRule, LoginResponse, TokenResponse, MeResponse } from "./types.js";

interface MockCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function mockFetch(handler: (call: MockCall) => { status: number; body?: unknown; headers?: Record<string, string> }) {
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
      headers: { "Content-Type": "application/json", ...(res.headers ?? {}) },
    });
  };
  return { fetch: fn, calls };
}

/* -------------------------------------------------- adapter — login */

test("login adapter normalises snake_case wire shape", async () => {
  const adapters: ResponseAdapters = {
    login: (raw): LoginResponse => {
      const b = raw as { session_token?: string; expires_at?: number; user?: { id?: string; display_name?: string }; tenants?: Array<{ id?: string; role?: string }> };
      const tenants = (b.tenants ?? []).map((t) => ({ id: t.id ?? "", role: t.role ?? "" }));
      return {
        accessToken: b.session_token,
        expiresAt: b.expires_at,
        user: { id: b.user?.id ?? "", displayName: b.user?.display_name },
        tenants,
        defaultTenantId: tenants[0]?.id,
      };
    },
  };

  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          status: "ok",
          session_token: "sid-1",
          expires_at: Math.floor((Date.now() + 3600_000) / 1000),
          user: { id: "u1", display_name: "User" },
          tenants: [{ id: "t1", role: "owner" }],
        },
      };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch, adapters });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "g" });
  const s = realm.getState();
  assert.equal(s.status, "authenticated");
  assert.equal(s.user?.id, "u1");
  assert.equal(s.user?.displayName, "User");
  assert.equal(s.currentTenantId, "t1");
  realm.close();
});

/* -------------------------------------------------- gate — tenants_required */

test("login → tenants_required surfaces typed error and pendingTenants", async () => {
  const adapters: ResponseAdapters = {
    login: (raw): LoginResponse => {
      const b = raw as { status?: string; tenants?: Array<{ id: string; role: string }> };
      if (b.status === "tenants_required") return { tenantsRequired: true, tenants: b.tenants };
      return raw as LoginResponse;
    },
  };
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: { status: "tenants_required", tenants: [{ id: "t1", role: "owner" }, { id: "t2", role: "member" }] },
      };
    }
    return { status: 404 };
  });

  const realm = createRealm({ baseUrl: "https://bff.test", fetch, adapters });
  await realm.ready();
  await assert.rejects(
    () => realm.login({ method: "google", providerToken: "g" }),
    (e) => e instanceof RealmError && e.code === "tenants_required",
  );
  assert.equal(realm.getState().pendingTenants?.length, 2);
  realm.close();
});

/* -------------------------------------------------- gate — 412 mfa */

test("412 mfa_required gate surfaces RealmError with challengeToken", async () => {
  const gates: GateRule[] = [
    {
      status: 412,
      code: "mfa_required",
      gate: "mfa_required",
      extract: (b) => {
        const x = (b ?? {}) as Record<string, unknown>;
        return { challengeToken: x.mfa_challenge_token, method: x.method };
      },
    },
  ];
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return { status: 412, body: { code: "mfa_required", mfa_challenge_token: "ch-1", method: "totp" } };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, gates });
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

/* -------------------------------------------------- gate — 412 session_limit */

test("412 session_limit_reached gate exposes revocationToken in error body", async () => {
  const gates: GateRule[] = [
    {
      status: 412,
      code: "session_limit_reached",
      gate: "session_limit_reached",
      extract: (b) => ({ revocationToken: (b as Record<string, unknown>).revocation_token }),
    },
  ];
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return { status: 412, body: { code: "session_limit_reached", revocation_token: "rev-1" } };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, gates });
  await realm.ready();
  let captured: RealmError | null = null;
  try {
    await realm.login({ method: "google", providerToken: "g" });
  } catch (e) {
    captured = e as RealmError;
  }
  assert.ok(captured && captured.code === "session_limit_reached");
  const body = captured.body as { revocationToken?: string };
  assert.equal(body.revocationToken, "rev-1");
  realm.close();
});

/* -------------------------------------------------- tokenless refresh */

test("tokenless refresh keeps existing bearer and advances expiry", async () => {
  let tokenCalls = 0;
  const adapters: ResponseAdapters = {
    login: (raw): LoginResponse => {
      const b = raw as { session_token: string; expires_at: number; user: { id: string }; tenants: Array<{ id: string; role: string }> };
      return {
        accessToken: b.session_token,
        expiresAt: b.expires_at,
        user: { id: b.user.id },
        tenants: b.tenants,
        defaultTenantId: b.tenants[0].id,
      };
    },
    token: (raw): TokenResponse => ({ expiresAt: (raw as { expires_at: number }).expires_at }),
  };
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          session_token: "sid-X",
          // already past skew so the next get() forces a refresh
          expires_at: Math.floor((Date.now() + 1000) / 1000),
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
        },
      };
    }
    if (call.url.endsWith("/token")) {
      tokenCalls++;
      return { status: 200, body: { expires_at: Math.floor((Date.now() + 3600_000) / 1000) } };
    }
    if (call.url.includes("/api/")) {
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });
  const realm = createRealm({
    baseUrl: "https://bff.test",
    fetch,
    adapters,
    refresh: { tokenless: true, sendBearer: true },
  });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "g" });
  await realm.fetch("https://api.test/api/x");
  assert.equal(tokenCalls, 1, "one /token rotation triggered by skew");
  const apiCall = calls.find((c) => c.url.includes("/api/x"))!;
  assert.equal(apiCall.headers["authorization"], "Bearer sid-X", "bearer unchanged");
  const tokenCall = calls.find((c) => c.url.endsWith("/token"))!;
  assert.equal(tokenCall.headers["authorization"], "Bearer sid-X", "sendBearer attaches current bearer");
  realm.close();
});

/* -------------------------------------------------- switch-tenant fallback */

test("switchTenant falls back to /login when endpoints.switchTenant=null", async () => {
  const adapters: ResponseAdapters = {
    login: (raw): LoginResponse => {
      const b = raw as { session_token: string; expires_at: number; user: { id: string }; tenants: Array<{ id: string; role: string }>; default_tenant_id?: string };
      return {
        accessToken: b.session_token,
        expiresAt: b.expires_at,
        user: { id: b.user.id },
        tenants: b.tenants,
        defaultTenantId: b.default_tenant_id ?? b.tenants[0].id,
      };
    },
  };
  const { fetch, calls } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      const tid = (call.body as { tenantId?: string } | undefined)?.tenantId ?? "t1";
      return {
        status: 200,
        body: {
          session_token: tid === "t2" ? "sid-T2" : "sid-T1",
          expires_at: Math.floor((Date.now() + 3600_000) / 1000),
          user: { id: "u1" },
          tenants: [
            { id: "t1", role: "owner" },
            { id: "t2", role: "member" },
          ],
          default_tenant_id: tid,
        },
      };
    }
    return { status: 404 };
  });
  const realm = createRealm({
    baseUrl: "https://bff.test",
    fetch,
    adapters,
    endpoints: { switchTenant: null },
  });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "g" });
  await realm.switchTenant("t2");
  assert.equal(realm.getState().currentTenantId, "t2");
  // Two login calls: original + tenant pin
  assert.equal(calls.filter((c) => c.url.endsWith("/login")).length, 2);
  realm.close();
});

/* -------------------------------------------------- CSRF */

test("CSRF tokenProvider attaches header on unsafe methods only", async () => {
  let csrfCalls = 0;
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
    return { status: 404 };
  });
  const realm = createRealm({
    baseUrl: "https://bff.test",
    fetch,
    csrf: {
      headerName: "X-CSRF-Token",
      tokenProvider: () => {
        csrfCalls++;
        return "csrf-abc";
      },
    },
  });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "g" });
  const me = calls.find((c) => c.url.endsWith("/me"))!;
  const login = calls.find((c) => c.url.endsWith("/login"))!;
  assert.equal(me.headers["x-csrf-token"], undefined, "GET /me has no CSRF");
  assert.equal(login.headers["x-csrf-token"], "csrf-abc", "POST /login carries CSRF");
  assert.ok(csrfCalls >= 1);
  realm.close();
});

/* -------------------------------------------------- expiresAt-only refresh */

test("login with only expiresAt schedules refresh correctly", async () => {
  const future = Math.floor((Date.now() + 90_000) / 1000); // 90s out, > 60s skew
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.endsWith("/login")) {
      return {
        status: 200,
        body: {
          accessToken: "at-only-at",
          expiresAt: future,
          user: { id: "u1" },
          tenants: [{ id: "t1", role: "owner" }],
          defaultTenantId: "t1",
        },
      };
    }
    if (call.url.includes("/api/")) {
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  await realm.login({ method: "google", providerToken: "g" });
  // Token valid for >60s, fetch should reuse it without refresh.
  const res = await realm.fetch("https://api.test/api/y");
  assert.equal(res.status, 200);
  realm.close();
});

/* -------------------------------------------------- restore error */

test("restore on 5xx surfaces error state, not anonymous", async () => {
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 503 };
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  const s = realm.getState();
  assert.equal(s.status, "error");
  assert.equal(s.errorReason, "server_error");
  realm.close();
});

/* -------------------------------------------------- adopt() */

test("adopt() seeds session from external bearer (e.g. sessionStorage restore)", async () => {
  let apiCalls = 0;
  const { fetch } = mockFetch((call) => {
    if (call.url.endsWith("/me")) return { status: 401 };
    if (call.url.includes("/api/x")) {
      apiCalls++;
      return { status: 200, body: { ok: true } };
    }
    return { status: 404 };
  });
  const realm = createRealm({ baseUrl: "https://bff.test", fetch });
  await realm.ready();
  realm.adopt({
    accessToken: "sid-Z",
    expiresAt: Math.floor((Date.now() + 3600_000) / 1000),
    tenantId: "t1",
    user: { id: "u1", email: "u@x" },
    tenants: [{ id: "t1", role: "owner" }],
  });
  assert.equal(realm.getState().status, "authenticated");
  assert.equal(realm.peekAccessToken(), "sid-Z");
  const res = await realm.fetch("https://api.test/api/x");
  assert.equal(res.status, 200);
  assert.equal(apiCalls, 1);
  realm.close();
});

/* -------------------------------------------------- snake-case me adapter */

test("me adapter populates state from flat snake_case shape", async () => {
  const adapters: ResponseAdapters = {
    me: (raw): MeResponse => {
      const b = raw as Record<string, unknown>;
      const tid = b.tenant_id as string | undefined;
      return {
        user: { id: b.user_id as string, email: b.email as string | undefined, displayName: b.display_name as string | undefined },
        tenants: tid ? [{ id: tid, role: (b.role as string) ?? "" }] : [],
        currentTenantId: tid,
        expiresAt: b.expires_at as number | undefined,
      };
    },
  };
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
  const realm = createRealm({ baseUrl: "https://bff.test", fetch, adapters });
  await realm.ready();
  const s = realm.getState();
  assert.equal(s.status, "authenticated");
  assert.equal(s.user?.id, "u1");
  assert.equal(s.user?.email, "u@x");
  assert.equal(s.currentTenantId, "t1");
  realm.close();
});
