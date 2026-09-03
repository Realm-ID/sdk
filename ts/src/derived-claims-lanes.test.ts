import { strict as assert } from "node:assert";
import { test } from "node:test";
import { AuthClient } from "./auth.js";
import { type ProductRolesHandler } from "./product-roles.js";

// derived-claims-lanes.test.ts — every session-producing lane resolves the
// derived claims, not just the ones someone remembered to list.
//
// The Go SDK carries an AST-DERIVED guard (derived_claims_lanes_test.go) that
// fails when a function handing back a session cannot reach the mint. It found
// TWO uncovered lanes — otpLogin and mfaVerify — where the defect report that
// prompted it had named only one, because that report was written off a
// hand-maintained "three call sites" comment.
//
// TypeScript has no equivalent compile-time walk here, so these are the
// behavioural mirror of that guard: one test per lane, asserting the mint
// actually happened and the handler saw the right (tenant, user). If you add a
// lane that returns a LoginResponse, add its row here.

interface Call {
  path: string;
  body: Record<string, unknown>;
}

const MINT = {
  access_token: "minted",
  refresh_token: "rtok2",
  expires_in: 900,
  subject_type: "user",
  tenant_id: "t1",
  role: "owner",
};

const SESSION = {
  refresh_token: "rtok",
  expires_in: 0,
  user: { id: "u1" },
  tenants: [{ tenant_id: "t1", role: "owner" }],
};

/** Answers `lanePath` with a settled single-tenant session, /auth/token with a mint. */
function laneHttp(lanePath: string, calls: Call[]) {
  return {
    async request<T>(opts: { method: string; path: string; body?: unknown }): Promise<T> {
      calls.push({ path: opts.path, body: (opts.body ?? {}) as Record<string, unknown> });
      if (opts.path === lanePath) return SESSION as T;
      if (opts.path === "/auth/token") return MINT as T;
      throw new Error("unexpected path " + opts.path);
    },
  } as never;
}

function client(lanePath: string, calls: Call[], handler: ProductRolesHandler) {
  return new AuthClient(laneHttp(lanePath, calls), "realm-1", async () => undefined, undefined, handler);
}

function mints(calls: Call[]): Call[] {
  return calls.filter((c) => c.path === "/auth/token");
}

test("otpLogin resolves the derived claims — an OTP login is a login", async () => {
  const calls: Call[] = [];
  let saw: [string, string] | undefined;
  const c = client("/auth/login", calls, async (tenantId, userId) => {
    saw = [tenantId, userId];
    return ["dispatch"];
  });

  await c.otpLogin({ identifier: "u@example.com", presented: "123456" });

  assert.equal(mints(calls).length, 1, "the OTP lane must mint exactly once");
  assert.deepEqual(saw, ["t1", "u1"]);
  assert.deepEqual(mints(calls)[0].body.product_roles, ["dispatch"]);
});

test("mfaVerify resolves the derived claims — the step-up token is the one the user keeps", async () => {
  const calls: Call[] = [];
  let saw: [string, string] | undefined;
  const c = client("/auth/mfa/verify", calls, async (tenantId, userId) => {
    saw = [tenantId, userId];
    return ["dispatch"];
  });

  await c.mfaVerify({ challengeToken: "mfa", code: "000000" });

  assert.equal(mints(calls).length, 1, "the MFA lane must mint exactly once");
  assert.deepEqual(saw, ["t1", "u1"]);
  assert.deepEqual(mints(calls)[0].body.product_roles, ["dispatch"]);
});

test("mfaVerifyOtp inherits the mint through its delegation to mfaVerify", async () => {
  const calls: Call[] = [];
  const c = client("/auth/mfa/verify", calls, async () => ["dispatch"]);

  await c.mfaVerifyOtp({ mfaToken: "mfa", presented: "000000" });

  assert.equal(mints(calls).length, 1, "mfaVerifyOtp must mint exactly once");
  assert.deepEqual(mints(calls)[0].body.product_roles, ["dispatch"]);
});
