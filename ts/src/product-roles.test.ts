import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AuthClient, needsTenantChoice, selectTenant, type LoginResponse } from "./auth.js";
import {
  LoginMintError,
  ProductRolesError,
  type ProductRolesHandler,
} from "./product-roles.js";

// product-roles.test.ts — ADR-102 D10/D11 in the TS SDK, plus the parity
// surface (needsTenantChoice / selectTenant / mfaRequired) ported from Go.

interface Call {
  path: string;
  body: Record<string, unknown>;
}

function fakeHttp(login: unknown, mint: unknown, calls: Call[]) {
  return {
    async request<T>(opts: { method: string; path: string; body?: unknown }): Promise<T> {
      calls.push({ path: opts.path, body: (opts.body ?? {}) as Record<string, unknown> });
      if (opts.path === "/auth/login") return login as T;
      if (opts.path === "/auth/token") return mint as T;
      throw new Error("unexpected path " + opts.path);
    },
  } as never;
}

const MINT = {
  access_token: "minted",
  refresh_token: "rtok2",
  expires_in: 900,
  subject_type: "user",
  tenant_id: "t1",
  role: "owner",
};

function client(handler?: ProductRolesHandler, calls: Call[] = [], login?: unknown) {
  return new AuthClient(
    fakeHttp(
      login ?? {
        refresh_token: "rtok",
        expires_in: 0,
        user: { id: "u1" },
        tenants: [{ tenant_id: "t1", role: "owner" }],
      },
      MINT,
      calls,
    ),
    "realm-1",
    async () => undefined,
    undefined,
    handler,
  );
}

// D10 — a single-tenant login MINTS, and the handler's output rides the mint.
test("a single-tenant login mints and carries the handler's roles", async () => {
  const calls: Call[] = [];
  let saw: [string, string] | undefined;
  const c = client((tenantId, userId) => {
    saw = [tenantId, userId];
    // A SPACE is legitimate: this is NOT the RFC 6749 §3.3 scope charset, and a
    // JSON array has no delimiter to break.
    return ["dispatch", "Regional Manager"];
  }, calls);

  const s = await c.login({ method: "firebase", providerToken: "pt" });

  assert.deepEqual(calls.map((x) => x.path), ["/auth/login", "/auth/token"]);
  assert.deepEqual(saw, ["t1", "u1"]);
  assert.deepEqual(calls[1]!.body.product_roles, ["dispatch", "Regional Manager"]);
  assert.equal(s.accessToken, "minted");
  assert.equal(s.refreshToken, "rtok2");
  assert.equal(s.tenantId, "t1");
});

// D10 — a MULTI-tenant login does NOT mint. The caller chooses, then completes.
//
// ⚠️ The failure this guards is silent: auto-picking tenants[0] would mint for
// an arbitrary org and resolve THAT org's roles — a wrong answer, not an error.
test("a multi-tenant login does not mint until the caller chooses", async () => {
  const calls: Call[] = [];
  const seen: string[] = [];
  const c = client((tenantId) => {
    seen.push(tenantId);
    return ["role-of-" + tenantId];
  }, calls, {
    refresh_token: "rtok",
    expires_in: 0,
    user: { id: "u1" },
    tenants: [
      { tenant_id: "t1", role: "member" },
      { tenant_id: "t2", role: "owner", mfa_required: true },
    ],
  });

  const s = await c.login({ method: "firebase", providerToken: "pt" });
  assert.deepEqual(calls.map((x) => x.path), ["/auth/login"]);
  assert.deepEqual(seen, [], "the handler must not run before a tenant is chosen");
  assert.equal(needsTenantChoice(s), true);
  // The ported mfaRequired field must survive the wire mapping.
  assert.equal(s.tenants[1]!.mfaRequired, true);

  // Choose t2 — deliberately NOT tenants[0], so an auto-pick would be visible.
  await c.completeLogin(s, "t2");
  assert.deepEqual(calls.map((x) => x.path), ["/auth/login", "/auth/token"]);
  assert.deepEqual(seen, ["t2"]);
  assert.deepEqual(calls[1]!.body.product_roles, ["role-of-t2"]);
  assert.equal(s.tenantId, "t2");
  assert.equal(s.role, "owner");
});

test("completeLogin refuses a tenant the session does not hold, locally", async () => {
  const calls: Call[] = [];
  const c = client(() => ["x"], calls);
  const s: LoginResponse = {
    accessToken: "", refreshToken: "r", expiresIn: 0,
    user: { id: "u1" }, tenants: [{ id: "t1", role: "member" }],
  };
  await assert.rejects(() => c.completeLogin(s, "t9"));
  await assert.rejects(() => c.completeLogin(s, ""));
  assert.equal(calls.length, 0, "nothing may leave for a caller-side mistake");
});

// D11 rule 1 — no handler means no claim, no error, and NO extra round trip
// when login already minted.
test("no handler configured costs nothing", async () => {
  const calls: Call[] = [];
  const c = client(undefined, calls, {
    access_token: "atok", refresh_token: "rtok", expires_in: 900,
    user: { id: "u1" }, tenants: [{ tenant_id: "t1", role: "owner" }],
  });
  const s = await c.login({ method: "firebase", providerToken: "pt" });
  assert.deepEqual(calls.map((x) => x.path), ["/auth/login"]);
  assert.equal(s.accessToken, "atok");
});

// D11 rule 2 — empty mints NO claim, not [].
test("an empty handler result mints no claim", async () => {
  const calls: Call[] = [];
  const c = client(() => [], calls);
  await c.login({ method: "firebase", providerToken: "pt" });
  assert.equal(
    "product_roles" in calls[1]!.body,
    false,
    "absent and empty must mean the same thing — every token issued before " +
      "ADR-102 has no claim at all",
  );
});

// D11 rule 3 — an error RETRIES, then REFUSES, and the error is the PARTNER'S.
test("a failing handler retries then refuses the mint", async () => {
  const calls: Call[] = [];
  let attempts = 0;
  const boom = new Error("role db unavailable");
  const c = client(() => {
    attempts++;
    throw boom;
  }, calls);

  const started = Date.now();
  await assert.rejects(
    () => c.login({ method: "firebase", providerToken: "pt" }),
    (err: unknown) => {
      // ADR-102 OQ8 — the failure arrives WRAPPED in a LoginMintError so the
      // session (the recovery anchor) has somewhere to ride. The partner's own
      // error is the cause, and it is a ProductRolesError, never a RealmError:
      // your outage and ours are different incidents.
      assert.ok(err instanceof LoginMintError, `want LoginMintError, got ${String(err)}`);
      const lme = err as LoginMintError;
      assert.ok(
        lme.cause instanceof ProductRolesError,
        "the cause must be a ProductRolesError, never a RealmError",
      );
      assert.equal((lme.cause as ProductRolesError).cause, boom);
      // THE ANCHOR. Throwing a bare error would drop it, and the users stranded
      // by that are exactly the ones ADR-092's session-limit affordance and
      // ADR-061's enrollment gate exist for.
      assert.ok(lme.session, "the session must ride on the error");
      assert.equal((lme.session as { refreshToken: string }).refreshToken, "rtok");
      assert.equal(lme.tenantId, "t1");
      return true;
    },
  );
  assert.equal(attempts, 3, "initial + 2 retries");
  assert.deepEqual(calls.map((x) => x.path), ["/auth/login"], "the mint must not be attempted");
  assert.ok(Date.now() - started < 3000, "the retry budget must be bounded (~200ms)");
});

// selectTenant is the Go-parity helper, and its tenants[0] fallback is exactly
// why it must NOT be used to settle the D10 multi-tenant branch.
test("selectTenant prefers the caller, then the session, then tenants[0]", () => {
  const s: LoginResponse = {
    accessToken: "", refreshToken: "r", expiresIn: 0,
    user: { id: "u1" },
    tenants: [{ id: "t1", role: "member" }, { id: "t2", role: "owner" }],
  };
  assert.deepEqual(selectTenant(s, "t2"), { tenantId: "t2", role: "owner" });
  assert.deepEqual(selectTenant(s), { tenantId: "t1", role: "member" });
  assert.deepEqual(selectTenant({ ...s, tenantId: "t2" }), { tenantId: "t2", role: "owner" });
});
