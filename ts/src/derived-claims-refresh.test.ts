import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AuthClient, type LoginResponse } from "./auth.js";
import { createRealm } from "./realm.js";
import { LoginMintError, type ProductRolesHandler } from "./product-roles.js";
import { ScopesError, type ScopesHandler } from "./scopes-handler.js";

// derived-claims-refresh.test.ts — the REFRESH lane must resolve the derived
// claims, exactly as the login lanes do.
//
// # The defect these guard
//
// `mintProductRoles` had three call sites — `login`, `completeLogin`,
// `passwordLogin` — and ALL THREE are login lanes. Nothing ran on refresh, and
// the middleware's own refresh minted with `{refreshToken, tenantId,
// customClaims}` only. So a BFF-fronted session carried `product_roles` at login
// and lost it roughly one access-TTL later, for the life of the session. `scope`
// had the identical hole, which is what blocked a partner's ADR-097 cutover.
//
// `product-roles.ts` promised the opposite in writing the whole time: "It runs
// on EVERY mint, refresh included, and nothing caches."
//
// ⚠️ THESE TESTS ARE LANE-SPECIFIC ON PURPOSE. An assertion that "a login
// carries the claim" passed throughout the entire life of the bug. The lane is
// the subject, not the claim.
//
// ⚠️ They assert the EFFECT ON THE WIRE, never that a handler was called. A test
// that asserts invocation passes while the value is dropped between the handler
// and the request body — the `credential_methods` shape, which has cost two
// releases.

/** An unsigned JWT carrying just a subject. `peekJwtSubject` does not verify —
 *  deliberately: the token is one the issuer signed and handed back moments ago,
 *  and a verification round trip on the refresh hot path buys nothing. */
function fakeJwt(sub: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "k" })}.${b64({ sub, exp: 4102444800 })}.sig`;
}

class MockRes {
  statusCode = 200;
  headers: Record<string, string | string[] | number> = {};
  chunks: string[] = [];
  headersSent = false;
  setHeader(n: string, v: string | string[] | number) { this.headers[n.toLowerCase()] = v; }
  getHeader(n: string) { return this.headers[n.toLowerCase()]; }
  writeHead(s: number) { this.statusCode = s; }
  end(c?: string) { if (c) this.chunks.push(c); this.headersSent = true; }
  get body() { return this.chunks.join(""); }
}

interface RefreshRig {
  /** Every `/auth/token` body the middleware sent, in order. */
  mints: Record<string, unknown>[];
  drive(): Promise<MockRes>;
}

/**
 * Stands a realm + middleware up over a fetch that answers `/auth/token` with a
 * token whose `sub` is `u-refresh`, and records every mint body.
 */
function refreshRig(cfg: { productRoles?: ProductRolesHandler; scopes?: ScopesHandler }): RefreshRig {
  const mints: Record<string, unknown>[] = [];
  const realm = createRealm({
    realmId: "r1",
    apiKey: "rk_live_x",
    baseUrl: "https://auth.test",
    origin: "https://app.test",
    productRoles: cfg.productRoles,
    scopes: cfg.scopes,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith("/auth/login")) {
        // The platform-key bootstrap the transport performs before any call.
        return new Response(JSON.stringify({
          status: "ok", subject_type: "platform",
          refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/auth/token")) {
        mints.push(body);
        return new Response(JSON.stringify({
          access_token: fakeJwt("u-refresh"),
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
      const mw = realm.middleware({});
      const req = {
        url: "/token",
        method: "POST",
        headers: { cookie: "realmid_refresh=rtok" },
        body: { tenant_id: "t1" },
      };
      const res = new MockRes();
      // The refresh lane terminates the request itself; `next` must never run.
      await mw(req as never, res as unknown as never, ((err?: unknown) => {
        throw new Error("middleware fell through to next on the refresh lane: " + String(err));
      }) as never);
      return res;
    },
  };
}

/** The body of the FINAL mint — the one whose token the caller ends up holding.
 *  Asserting on the first would pass while the claim was dropped from the token
 *  that actually gets used. */
function last(mints: Record<string, unknown>[]): Record<string, unknown> {
  assert.ok(mints.length > 0, "no /auth/token call was made at all");
  return mints[mints.length - 1]!;
}

// THE REGRESSION TEST. Red before the fix: the refresh minted without ever
// calling the handler, so `product_roles` was absent from the wire.
test("refresh lane: the product_roles handler runs and its roles reach the FINAL mint", async () => {
  let saw: [string, string] | undefined;
  const rig = refreshRig({
    productRoles: (tenantId, userId) => { saw = [tenantId, userId]; return ["dispatch"]; },
  });

  await rig.drive();

  assert.deepEqual(
    last(rig.mints).product_roles,
    ["dispatch"],
    "product_roles absent from the refresh mint — product-roles.ts promises it 'runs on EVERY mint, refresh included'",
  );
  // The subject must come from the minted token, not be invented or left blank:
  // a handler resolving roles for the empty user is a silent wrong answer.
  assert.deepEqual(saw, ["t1", "u-refresh"]);
});

// The same lane, the same hole, for ADR-097 granted authority. This is the one
// that blocked a partner: with `scope` absent, `scopesFrom` reads nothing and
// every `ScopePolicy` gate denies about one access-TTL into every session.
test("refresh lane: the scopes handler runs and its scopes reach the FINAL mint, space-delimited", async () => {
  let saw: [string, string] | undefined;
  const rig = refreshRig({
    scopes: (tenantId, userId) => { saw = [tenantId, userId]; return ["invoices:read", "invoices:write"]; },
  });

  await rig.drive();

  // Space-delimited on the wire (ADR-097), not an array — the issuer's `scope`
  // claim is a string and `scopesFrom` splits on whitespace.
  assert.equal(last(rig.mints).scope, "invoices:read invoices:write");
  assert.deepEqual(saw, ["t1", "u-refresh"]);
});

// COST GUARD, and the assertion most likely to rot. The re-mint is a SECOND
// round trip, so a consumer who adopts neither handler must keep paying for
// exactly one. Asserting only the body would let the extra call creep in
// unnoticed — this asserts the COUNT.
test("refresh lane: with no handler configured the refresh mints exactly ONCE", async () => {
  const rig = refreshRig({});

  await rig.drive();

  assert.equal(rig.mints.length, 1, "no handler configured must cost exactly one mint");
  assert.equal("product_roles" in rig.mints[0]!, false, "product_roles must be ABSENT, not empty");
  assert.equal("scope" in rig.mints[0]!, false, "scope must be ABSENT, not empty");
});

// An empty result mints NO claim, not `[]`. Absent and empty must mean the same
// thing for these two, because every token issued before the feature has no
// claim at all and a reader handles absence regardless.
//
// ⚠️ This rule is NOT shared by role_permissions, where an empty non-nil list is
// a real instruction the issuer answers with a 403. Do not harmonise them.
test("refresh lane: an empty/undefined handler result mints NO claim", async () => {
  const rig = refreshRig({
    productRoles: () => [],
    scopes: () => [],
  });

  await rig.drive();

  const b = last(rig.mints);
  assert.equal("product_roles" in b, false, "an empty handler result must mint no product_roles claim");
  assert.equal("scope" in b, false, "an empty handler result must mint no scope claim");
});

// ---------------------------------------------------------------------------
// The LOGIN lane. A `scopes` handler that worked on refresh but not here would
// reproduce the exact defect being fixed, pointed the other way — and it would
// be found the same way: by a partner, in production.
// ---------------------------------------------------------------------------

interface Call { path: string; body: Record<string, unknown> }

function loginClient(
  calls: Call[],
  handlers: { productRoles?: ProductRolesHandler; scopes?: ScopesHandler },
): AuthClient {
  const http = {
    async request<T>(opts: { method: string; path: string; body?: unknown }): Promise<T> {
      calls.push({ path: opts.path, body: (opts.body ?? {}) as Record<string, unknown> });
      if (opts.path === "/auth/login") {
        return {
          // An access token IS returned here on purpose: the mintProductRoles
          // short-circuit is `no handler AND a token already in hand`, so a
          // login stub that returns none would mint regardless and the
          // scopes-only test below would pass vacuously.
          access_token: fakeJwt("u1"),
          refresh_token: "rtok",
          expires_in: 900,
          user: { id: "u1" },
          tenants: [{ tenant_id: "t1", role: "owner" }],
        } as T;
      }
      if (opts.path === "/auth/token") {
        return {
          access_token: fakeJwt("u1"), refresh_token: "rtok2", expires_in: 900,
          subject_type: "user", tenant_id: "t1", role: "owner",
        } as T;
      }
      throw new Error("unexpected path " + opts.path);
    },
  } as never;
  return new AuthClient(http, "r1", async () => undefined, undefined, handlers.productRoles, handlers.scopes);
}

// mintProductRoles is the shared login-lane mint (login, completeLogin,
// passwordLogin), so proving it here proves all three.
test("login lane: the scopes handler runs and its scopes reach the login mint", async () => {
  const calls: Call[] = [];
  let saw: [string, string] | undefined;
  const c = loginClient(calls, {
    scopes: (tenantId, userId) => { saw = [tenantId, userId]; return ["invoices:read"]; },
  });

  await c.login({ method: "firebase", providerToken: "pt" });

  assert.deepEqual(saw, ["t1", "u1"]);
  const mint = calls.find((x) => x.path === "/auth/token");
  assert.ok(mint, "login did not mint at all");
  assert.equal(mint.body.scope, "invoices:read");
});

// A `scopes` handler ALONE must be enough to trigger the login mint. The guard
// in mintProductRoles short-circuits when no handler is set and a token is
// already in hand; if it only ever consulted productRoles, a scopes-only
// consumer would silently never mint.
test("login lane: a scopes-ONLY consumer still mints on login", async () => {
  const calls: Call[] = [];
  const c = loginClient(calls, { scopes: () => ["invoices:read"] });

  await c.login({ method: "firebase", providerToken: "pt" });

  assert.deepEqual(calls.map((x) => x.path), ["/auth/login", "/auth/token"]);
});

// The handler's error REFUSES the mint and HANDS BACK the session, so the caller
// can recover rather than losing a login that actually succeeded.
test("login lane: a failing scopes handler refuses the mint and hands the session back", async () => {
  const calls: Call[] = [];
  const c = loginClient(calls, {
    scopes: () => { throw new Error("scope store down"); },
  });

  let err: unknown;
  try {
    await c.login({ method: "firebase", providerToken: "pt" });
  } catch (e) { err = e; }

  assert.ok(err instanceof LoginMintError, `want a LoginMintError carrying the session, got ${String(err)}`);
  assert.ok(
    (err as LoginMintError).cause instanceof ScopesError,
    "want a ScopesError underneath — YOUR handler failing and RealmID refusing a mint are different incidents",
  );
  assert.equal(((err as LoginMintError).cause as ScopesError).attempts, 3, "the shared retry budget is 3");
  const session = (err as LoginMintError).session as LoginResponse;
  assert.ok(session, "the session must travel on the error — the login itself succeeded");
  assert.equal(session.refreshToken, "rtok");
  assert.equal(calls.filter((x) => x.path === "/auth/token").length, 0, "the mint must never be sent");
});
