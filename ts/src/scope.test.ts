import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { Claims } from "./claims.js";
import {
  scopesFrom,
  scopeAllows,
  scopeAllowsAny,
  decideScope,
  validateScopePolicy,
  createScopeMiddleware,
  fastifyScopeHook,
  type ScopePolicy,
  type ScopeDecision,
} from "./scope.js";

function claimsWith(scope: unknown): Claims {
  return { iss: "i", sub: "s", aud: "a", exp: 0, iat: 0, scope } as unknown as Claims;
}

// Every way the predicate can be asked a question it cannot answer. Each must
// be false.
//
// The empty-required case is the one worth arguing about: scopeAllows(c) with
// no scopes returns FALSE, not true. Vacuous-true on an empty requirement is
// how a gate silently stops gating — a route someone forgot to configure would
// pass every caller — and a genuinely public route is DECLARED, not inferred.
test("scopeAllows fails closed", () => {
  const full = claimsWith("a b c");
  const cases: Array<[string, Claims | null, string[], boolean]> = [
    ["null claims", null, ["a"], false],
    ["no scope claim", claimsWith(undefined), ["a"], false],
    ["empty scope claim", claimsWith(""), ["a"], false],
    ["whitespace-only", claimsWith("   "), ["a"], false],
    ["no required scopes is NOT vacuously true", full, [], false],
    ["single hit", full, ["b"], true],
    ["all-of, all present", full, ["a", "c"], true],
    ["all-of, one missing", full, ["a", "z"], false],
    ["no prefix implication", claimsWith("read"), ["read:orders"], false],
    ["no suffix implication", claimsWith("read:orders"), ["read"], false],
    ["no wildcard expansion", claimsWith("*"), ["anything"], false],
    ["case-sensitive", claimsWith("read"), ["Read"], false],
    // RFC 9068 §2.2.3 makes this claim a STRING. Quietly accepting an array
    // would mask a wire mismatch that ought to be loud.
    ["array-shaped claim is not read", claimsWith(["a"]), ["a"], false],
    ["number-shaped claim is not read", claimsWith(7), ["7"], false],
  ];
  for (const [name, claims, required, want] of cases) {
    assert.equal(scopeAllows(claims, ...required), want, name);
  }
});

test("scopeAllowsAny differs from scopeAllows and fails closed", () => {
  const c = claimsWith("a b");
  assert.equal(scopeAllowsAny(c, "z", "b"), true, "one hit is enough");
  assert.equal(scopeAllowsAny(c, "y", "z"), false, "no hits");
  assert.equal(scopeAllowsAny(c), false, "empty required is not vacuously true");
  assert.equal(scopeAllowsAny(null, "a"), false, "null claims");
  // If these two ever agree on a partially-held set, one of them is decoration.
  assert.notEqual(scopeAllows(c, "a", "z"), scopeAllowsAny(c, "a", "z"));
});

test("scopesFrom preserves the issuer's order and splits on runs", () => {
  assert.deepEqual(scopesFrom(claimsWith("c  a   b")), ["c", "a", "b"]);
  assert.deepEqual(scopesFrom(null), []);
  assert.deepEqual(scopesFrom(claimsWith(["a"])), []);
});

// The property that makes the route map safe: adding an endpoint and forgetting
// to declare its scope produces a LOCKED DOOR, not an open one.
test("a policy denies by default", () => {
  const policy: ScopePolicy = [{ path: "/orders/**", scopes: ["orders:read"] }];
  const c = claimsWith("orders:read admin");

  // PRECONDITION: the declared route IS allowed, so the denial below is
  // attributable to the missing declaration and not to a broken policy.
  assert.equal(decideScope(policy, c, "GET", "/orders/42").allowed, true,
    "PRECONDITION: the declared route must be allowed");

  const d = decideScope(policy, c, "GET", "/invoices/42");
  assert.equal(d.allowed, false, "an UNDECLARED route must be denied, even to a token holding every scope");
  assert.equal(d.matched, false, "matched=false lets a caller tell a config gap from an authz failure");

  // A missing policy denies too — a wiring mistake must not look like a
  // deliberately open service.
  assert.equal(decideScope(null, c, "GET", "/orders/42").allowed, false);
  assert.equal(decideScope(undefined, c, "GET", "/orders/42").allowed, false);
});

test("public, anyOf, method and first-match-wins", () => {
  const policy: ScopePolicy = [
    { path: "/health", public: true },
    { path: "/orders/*/export", scopes: ["orders:export"] },
    { path: "/orders/**", method: "GET", scopes: ["orders:read"] },
    { path: "/orders/**", scopes: ["orders:write", "orders:read"] },
    { path: "/reports/**", scopes: ["r:a", "r:b"], anyOf: true },
  ];

  assert.equal(decideScope(policy, null, "GET", "/health").allowed, true,
    "a public route must allow a request with no claims at all");

  const read = claimsWith("orders:read");
  assert.equal(decideScope(policy, read, "GET", "/orders/7").allowed, true);
  assert.equal(decideScope(policy, read, "POST", "/orders/7").allowed, false,
    "POST falls through to the write rule");

  // /orders/7/export matches BOTH the export rule and the GET rule; the export
  // rule is first, so it decides.
  const exp = decideScope(policy, read, "GET", "/orders/7/export");
  assert.equal(exp.allowed, false, "the earlier, more specific rule must decide");
  assert.deepEqual(exp.required, ["orders:export"]);

  assert.equal(decideScope(policy, read, "POST", "/orders/7").allowed, false,
    "a two-scope rule requires BOTH by default");
  assert.equal(decideScope(policy, claimsWith("r:a"), "GET", "/reports/x").allowed, true,
    "anyOf passes on one of two");

  assert.deepEqual(decideScope(policy, read, "POST", "/orders/7").missing, ["orders:write"]);
  assert.deepEqual(decideScope(policy, claimsWith("nope"), "GET", "/reports/x").missing, [],
    "an anyOf denial has no single missing scope");
});

// These are the mistakes a partner makes once and should learn about at
// startup, not from traffic.
test("validateScopePolicy reports every problem, not the first", () => {
  const errs = validateScopePolicy([
    { path: "", scopes: ["a"] },
    { path: "/a", public: true, scopes: ["a"] },
    { path: "/b" },
    { path: "/c", scopes: ["has space"] },
    { path: "/ok", scopes: ["fine"] },
  ]);
  assert.equal(errs.length, 4, `want 4 errors, got ${JSON.stringify(errs)}`);
  for (const e of errs) assert.ok(e.message.length > 0);
  assert.deepEqual(validateScopePolicy([{ path: "/ok", scopes: ["fine"] }]), []);
});

class Res {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";
  setHeader(n: string, v: string) { this.headers[n.toLowerCase()] = v; }
  end(chunk?: string) { if (chunk) this.body += chunk; }
}

// Telling an unauthorized caller which permissions they lack hands out a map of
// the API's authority model for free. The names go to the SERVER, via
// onScopeDenied.
test("the Express adapter 403s without leaking the scope names", () => {
  const policy: ScopePolicy = [{ path: "/secret", scopes: ["very:secret:permission"] }];
  let seen: ScopeDecision | null = null;
  const mw = createScopeMiddleware(policy, { onScopeDenied: (_r, d) => { seen = d; } });

  const res = new Res();
  let nexted = false;
  mw({ method: "GET", url: "/secret?q=1" }, res, () => { nexted = true; });

  assert.equal(nexted, false, "a denied request must not reach the handler");
  assert.equal(res.statusCode, 403);
  assert.ok(res.body.includes("insufficient_scope"), "RFC 6750 §3.1 code");
  assert.ok(!res.body.includes("very:secret:permission"), "the 403 body LEAKED the required scope name");
  assert.ok(seen, "onScopeDenied must fire, or the names are lost to the server too");
  assert.deepEqual(seen!.missing, ["very:secret:permission"]);

  // PRECONDITION for the negative above: with the scope, the handler runs.
  // Without this, an adapter that refused everything would pass every assertion.
  let allowed = false;
  mw(
    { method: "GET", url: "/secret", realmid: claimsWith("very:secret:permission") },
    new Res(),
    () => { allowed = true; },
  );
  assert.equal(allowed, true, "an authorized request must reach the handler");
});

test("the Fastify hook enforces the same policy", () => {
  const policy: ScopePolicy = [{ path: "/secret", scopes: ["s"] }];
  const hook = fastifyScopeHook(policy);

  let status = 0;
  let body: unknown = null;
  let done = false;
  hook({ method: "GET", url: "/secret" }, {
    code(s: number) { status = s; return { send(b: unknown) { body = b; return null; } }; },
  }, () => { done = true; });
  assert.equal(status, 403);
  assert.equal(done, false);
  assert.equal((body as { error: { code: string } }).error.code, "insufficient_scope");

  let allowed = false;
  hook({ method: "GET", url: "/secret", realmid: claimsWith("s") }, {
    code() { throw new Error("must not reply"); },
  }, () => { allowed = true; });
  assert.equal(allowed, true);
});
