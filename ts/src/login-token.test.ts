import { test } from "node:test";
import { strict as assert } from "node:assert";
import { RealmError } from "./errors.js";
import { needsTenantChoice } from "./auth.js";
import { FakeIssuer, jsonReply } from "./split-testutil.test.js";

// SPEC14_1_login_token (R44, R62, R71): login authenticates; /auth/token mints. The fake login
// answers WITH a stray access_token to prove the SDK never reads it.

function loginFake(tenants: unknown[]): FakeIssuer {
  const f = new FakeIssuer();
  f.on("/auth/login", () => jsonReply(200, {
    access_token: "LEAKED-FROM-LOGIN", refresh_token: "rt1", expires_in: 900, user: { id: "u1" }, tenants,
  }));
  f.on("/auth/token", () => jsonReply(200, {
    access_token: "MINTED-AT", refresh_token: "rt2", expires_in: 600, tenant_id: "t1", role: "member",
  }));
  return f;
}

const userMints = (f: FakeIssuer) => f.reqs("/auth/token").filter((r) => r.body?.grant_type !== "platform_api_key");

test("login-token: single tenant mints at /auth/token and ignores login's access_token", async () => {
  const f = loginFake([{ tenant_id: "t1", role: "member" }]);
  const s = await f.realm().auth.login({ method: "google", providerToken: "pt" });
  assert.equal(s.accessToken, "MINTED-AT", "AccessToken must be the /auth/token mint, never login's access_token");
  const mints = userMints(f);
  assert.equal(mints.length, 1, "exactly one user mint (auto-mint on exactly one tenant, R44)");
  assert.equal(mints[0]!.body?.refresh_token, "rt1");
  assert.equal(mints[0]!.body?.tenant_id, "t1");
  assert.equal(mints[0]!.auth, "Bearer ptok");
});

test("login-token: several tenants do not mint and drop login's access_token", async () => {
  const f = loginFake([{ tenant_id: "t1" }, { tenant_id: "t2" }]);
  const realm = f.realm();
  const s = await realm.auth.login({ method: "google", providerToken: "pt" });
  assert.equal(s.accessToken ?? "", "", "login's access_token must never be surfaced before a tenant choice");
  assert.equal(needsTenantChoice(s), true);
  await realm.auth.completeLogin(s, "t2");
  assert.equal(s.accessToken, "MINTED-AT");
});

test("login-token: MFA verify, recovery and invite-accept exchange at /auth/token too (R51)", async () => {
  const f = loginFake([]);
  const raw = () => jsonReply(200, {
    access_token: "LEAKED", refresh_token: "rt1", expires_in: 900, user: { id: "u1" },
    tenants: [{ tenant_id: "t1", role: "member" }],
  });
  f.on("/auth/mfa/verify", raw);
  f.on("/auth/mfa/recovery", raw);
  f.on("/auth/invitations/accept", raw);
  const a = f.realm().auth;
  assert.equal((await a.mfaVerify({ challengeToken: "ct", code: "123456" })).accessToken, "MINTED-AT", "mfa verify");
  assert.equal((await a.redeemRecoveryCode({ challengeToken: "ct", code: "rc" })).accessToken, "MINTED-AT", "recovery");
  assert.equal((await a.acceptInvitation({ token: "it", username: "u", password: "p" })).accessToken, "MINTED-AT", "invite accept");
});

test("login-token: the platform mint goes to /auth/token only, never /auth/login", async () => {
  const f = new FakeIssuer();
  f.on("/tenants/t1", () => jsonReply(200, { id: "t1" }));
  await f.realm().tenants.get("t1");
  assert.equal(f.reqs("/auth/login").length, 0, "platform_api_key was sent to /auth/login");
  const pm = f.reqs("/auth/token");
  assert.equal(pm.length, 1);
  assert.equal(pm[0]!.body?.grant_type, "platform_api_key");
  assert.equal(pm[0]!.body?.api_key, "rk");
});

test("login-token: no fallback to /auth/login when the token endpoint fails (R71)", async () => {
  const f = new FakeIssuer();
  f.override = (r) => (r.path === "/auth/token" ? jsonReply(404, { error: { code: "not_found", message: "old issuer" } }) : undefined);
  await assert.rejects(f.realm().tenants.get("t1"), RealmError);
  assert.equal(f.reqs("/auth/login").length, 0, "fell back to /auth/login; R71 forbids any fallback");
});
