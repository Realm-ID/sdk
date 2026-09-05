import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AuthClient, type LoginResponse } from "./auth.js";
import { createRealm } from "./realm.js";
import { LoginMintError, type ProductRolesHandler } from "./product-roles.js";
import { ScopesError, type ScopesHandler } from "./scopes-handler.js";
import {
  IdentityResolvedError,
  type IdentityResolvedEvent,
  type IdentityResolvedHandler,
} from "./identity-resolved.js";

// identity-resolved.test.ts — `onIdentityResolved` fires immediately before
// `ProductRoles` / `Scopes` are resolved, on every lane where they are
// resolved, and its error refuses the mint. Design doc:
// `../docs/design/pre-mint-hook.md`.
//
// ⚠️ §10.1's warning, taken literally here: a test that only records
// `["hook", "scopes"]` in an ordered slice can be satisfied by a reordering
// that happens to log the same way. THE NAMED TEST below instead makes the
// `scopes` resolver's return value be PRODUCED BY the hook's write, so a
// reordering (hook after the resolver) cannot pass it by accident.

interface Call {
  path: string;
  body: Record<string, unknown>;
}

function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "k" })}.${b64(claims)}.sig`;
}

function loginClient(
  calls: Call[],
  handlers: {
    productRoles?: ProductRolesHandler;
    scopes?: ScopesHandler;
    onIdentityResolved?: IdentityResolvedHandler;
  },
  loginBody: Record<string, unknown> = {
    access_token: fakeJwt({ sub: "u1" }),
    refresh_token: "rtok",
    expires_in: 900,
    user: { id: "u1", email: "u1@example.com", display_name: "U One" },
    tenants: [{ tenant_id: "t1", role: "owner" }],
  },
): AuthClient {
  const http = {
    async request<T>(opts: { method: string; path: string; body?: unknown }): Promise<T> {
      calls.push({ path: opts.path, body: (opts.body ?? {}) as Record<string, unknown> });
      if (opts.path === "/auth/login") return loginBody as T;
      if (opts.path === "/auth/mfa/verify") return loginBody as T;
      if (opts.path === "/auth/token") {
        return {
          access_token: fakeJwt({ sub: "u1" }),
          refresh_token: "rtok2",
          expires_in: 900,
          subject_type: "user",
          tenant_id: "t1",
          role: "owner",
        } as T;
      }
      throw new Error("unexpected path " + opts.path);
    },
  } as never;
  return new AuthClient(
    http,
    "realm-1",
    async () => undefined,
    undefined,
    handlers.productRoles,
    handlers.scopes,
    handlers.onIdentityResolved,
  );
}

function mints(calls: Call[]): Call[] {
  return calls.filter((c) => c.path === "/auth/token");
}

// THE NAMED TEST (§10.1). RED under a reordering: move the fire site below
// resolveScopes and this must fail.
test("runs before scope resolution and its write is visible to the resolver", async () => {
  const mirror = new Map<string, string[]>();
  const calls: Call[] = [];
  const c = loginClient(calls, {
    onIdentityResolved: (ev) => {
      mirror.set(`${ev.tenantId}:${ev.userId}`, ["orders:read"]);
    },
    scopes: (tenantId, userId) => mirror.get(`${tenantId}:${userId}`) ?? [],
  });

  await c.login({ method: "firebase", providerToken: "pt" });

  const mint = mints(calls)[0];
  assert.ok(mint, "login did not mint at all");
  assert.equal(mint.body.scope, "orders:read");
});

test("mutating the event has no effect on the resolution that follows", async () => {
  const calls: Call[] = [];
  const c = loginClient(calls, {
    onIdentityResolved: (ev) => {
      // @ts-expect-error — deliberately mutating a readonly field to prove
      // it has no effect, not to recommend it.
      ev.tenantId = "some-other-tenant";
      // @ts-expect-error
      ev.userId = "someone-else";
    },
    scopes: (tenantId, userId) => [`${tenantId}:${userId}`],
  });

  await c.login({ method: "firebase", providerToken: "pt" });

  assert.equal(mints(calls)[0]!.body.scope, "t1:u1");
});

test("fires with Flow=login on a settled single-tenant login", async () => {
  const calls: Call[] = [];
  const seen: IdentityResolvedEvent[] = [];
  const c = loginClient(calls, { onIdentityResolved: (ev) => { seen.push(ev); } });

  await c.login({ method: "firebase", providerToken: "pt" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.flow, "login");
  assert.equal(seen[0]!.tenantId, "t1");
  assert.equal(seen[0]!.userId, "u1");
  assert.equal(seen[0]!.role, "owner");
  assert.equal(seen[0]!.email, "u1@example.com");
  assert.equal(seen[0]!.realmId, "realm-1");
});

test("fires with Flow=otp on otpLogin", async () => {
  const calls: Call[] = [];
  const seen: IdentityResolvedEvent[] = [];
  const c = loginClient(calls, { onIdentityResolved: (ev) => { seen.push(ev); } }, {
    access_token: fakeJwt({ sub: "u1" }),
    refresh_token: "rtok",
    expires_in: 900,
    user: { id: "u1" },
    tenants: [{ tenant_id: "t1", role: "owner" }],
  });

  await c.otpLogin({ identifier: "u1@example.com", presented: "123456" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.flow, "otp");
});

test("fires with Flow=password on passwordLogin", async () => {
  const calls: Call[] = [];
  const seen: IdentityResolvedEvent[] = [];
  const c = loginClient(calls, { onIdentityResolved: (ev) => { seen.push(ev); } });

  await c.passwordLogin({ identifier: "u1@example.com", presented: "hunter2" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.flow, "password");
});

test("fires with Flow=mfa_verify on mfaVerify, and mfaVerifyOtp inherits it once via delegation", async () => {
  const calls: Call[] = [];
  const seen: IdentityResolvedEvent[] = [];
  const c = loginClient(calls, { onIdentityResolved: (ev) => { seen.push(ev); } });

  await c.mfaVerify({ challengeToken: "mfa", code: "000000" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.flow, "mfa_verify");

  seen.length = 0;
  await c.mfaVerifyOtp({ mfaToken: "mfa", presented: "000000" });
  assert.equal(seen.length, 1, "mfaVerifyOtp must fire the hook exactly once, not twice, via its delegation");
  assert.equal(seen[0]!.flow, "mfa_verify");
});

// §4.2 — a multi-tenant login does NOT settle a tenant, so it must not fire;
// completeLogin fires once per tenant it settles, including a later SWITCH.
test("fires once per tenant: zero on a multi-tenant login, once per completeLogin, again on a switch", async () => {
  const calls: Call[] = [];
  const seen: IdentityResolvedEvent[] = [];
  const c = loginClient(
    calls,
    { onIdentityResolved: (ev) => { seen.push(ev); } },
    {
      // NO tenant_id and >1 tenant => needsTenantChoice, mintProductRoles never runs.
      access_token: "",
      refresh_token: "rtok",
      expires_in: 900,
      user: { id: "u1" },
      tenants: [{ tenant_id: "t1", role: "owner" }, { tenant_id: "t2", role: "member" }],
    },
  );

  const session = await c.login({ method: "firebase", providerToken: "pt" });
  assert.equal(seen.length, 0, "an unsettled multi-tenant login must not fire the hook");

  await c.completeLogin(session, "t1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.flow, "tenant_choice");
  assert.equal(seen[0]!.tenantId, "t1");

  await c.completeLogin(session, "t2");
  assert.equal(seen.length, 2, "a tenant SWITCH through completeLogin must fire again, for the new tenant");
  assert.equal(seen[1]!.tenantId, "t2");
});

// §5 — the hook's error refuses the mint unconditionally, and on the login
// lanes the session rides the LoginMintError anchor exactly as a ScopesError
// does today.
test("a failing hook refuses the mint, no /auth/token is sent, and the session rides LoginMintError", async () => {
  const calls: Call[] = [];
  const c = loginClient(calls, {
    onIdentityResolved: () => { throw new Error("mirror db down"); },
    scopes: () => ["should-never-be-reached"],
  });

  let err: unknown;
  try {
    await c.login({ method: "firebase", providerToken: "pt" });
  } catch (e) {
    err = e;
  }

  assert.ok(err instanceof LoginMintError, `want a LoginMintError carrying the session, got ${String(err)}`);
  assert.ok(
    (err as LoginMintError).cause instanceof IdentityResolvedError,
    "want an IdentityResolvedError underneath — the hook failing and RealmID refusing a mint are different incidents",
  );
  const session = (err as LoginMintError).session as LoginResponse;
  assert.ok(session, "the session must travel on the error — the login itself succeeded");
  assert.equal(mints(calls).length, 0, "the mint must never be sent once the hook has refused it");
  assert.equal(calls.filter((x) => x.path === "/auth/login").length, 1);
});

test("a hook alone (no productRoles/scopes) still fires, without forcing an extra mint round trip", async () => {
  const calls: Call[] = [];
  let fired = 0;
  const c = loginClient(calls, { onIdentityResolved: () => { fired++; } });

  await c.login({ method: "firebase", providerToken: "pt" });

  assert.equal(fired, 1, "the hook must fire even when neither sibling resolver is configured");
  assert.equal(mints(calls).length, 0, "with no claim to add, the short-circuit must still skip the round trip");
});

// ---------------------------------------------------------------------------
// The REFRESH lane (OQ-1).
// ---------------------------------------------------------------------------

function refreshRig(cfg: {
  productRoles?: ProductRolesHandler;
  scopes?: ScopesHandler;
  onIdentityResolved?: IdentityResolvedHandler;
  refreshSub?: string;
}): { mints: Record<string, unknown>[]; drive(): Promise<void> } {
  const mints: Record<string, unknown>[] = [];
  const realm = createRealm({
    realmId: "r1",
    apiKey: "rk_live_x",
    baseUrl: "https://auth.test",
    origin: "https://app.test",
    productRoles: cfg.productRoles,
    scopes: cfg.scopes,
    onIdentityResolved: cfg.onIdentityResolved,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/auth/login")) {
        return new Response(JSON.stringify({
          status: "ok", subject_type: "platform",
          refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/auth/token")) {
        mints.push(body);
        return new Response(JSON.stringify({
          access_token: cfg.refreshSub === "" ? "not-a-jwt" : fakeJwt({
            sub: cfg.refreshSub ?? "u-refresh",
            email: "refresh@example.com",
            name: "Refresh User",
          }),
          refresh_token: `rtok${mints.length + 1}`,
          expires_in: 900,
          subject_type: "user",
          tenant_id: "t1",
          role: "member",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected url " + url);
    }) as typeof fetch,
  });

  return {
    mints,
    async drive() {
      const out = await realm.auth.token({ refreshToken: "rtok", tenantId: "t1" });
      await realm.auth.enrichRefresh(out, "t1");
    },
  };
}

test("refresh lane: fires with Flow=refresh, sourcing email/displayName off the minted token", async () => {
  const seen: IdentityResolvedEvent[] = [];
  const rig = refreshRig({
    onIdentityResolved: (ev) => { seen.push(ev); },
    scopes: () => ["invoices:read"],
  });

  await rig.drive();

  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.flow, "refresh");
  assert.equal(seen[0]!.tenantId, "t1");
  assert.equal(seen[0]!.userId, "u-refresh");
  assert.equal(seen[0]!.email, "refresh@example.com");
  assert.equal(seen[0]!.displayName, "Refresh User");
  assert.equal(seen[0]!.role, "", "the refresh lane's session carries no role");
});

test("refresh lane: a hook alone (no sibling resolver) still fires and consults the short-circuit", async () => {
  let fired = 0;
  const rig = refreshRig({ onIdentityResolved: () => { fired++; } });

  await rig.drive();

  assert.equal(fired, 1, "onIdentityResolved alone must not be short-circuited out on refresh");
});

test("refresh lane: a failing hook refuses the re-mint", async () => {
  const rig = refreshRig({
    onIdentityResolved: () => { throw new Error("mirror db down"); },
    scopes: () => ["should-never-be-reached"],
  });

  await assert.rejects(() => rig.drive(), IdentityResolvedError);
  // rig.mints already carries the FIRST /auth/token call `drive()` makes
  // before `enrichRefresh` ever runs; the assertion is that the hook's
  // failure prevents a SECOND one (the re-mint), not that the count is zero.
  assert.equal(rig.mints.length, 1, "the re-mint must never be sent once the hook has refused it");
});

test("refresh lane: an unreadable subject REFUSES the refresh when the hook is configured", async () => {
  const rig = refreshRig({ onIdentityResolved: () => {}, refreshSub: "" });

  await assert.rejects(() => rig.drive());
  assert.equal(rig.mints.length, 1, "no re-mint is attempted once the subject cannot be read");
});
