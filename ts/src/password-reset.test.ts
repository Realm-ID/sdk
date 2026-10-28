/**
 * ADR-111 + ADR-104 amendment (SPEC §3.1, §4.1.4, §4.1.8, §4.10, §6.3). Names
 * mirror go/password_reset_test.go and go/me_password_test.go.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { createMemorySessionStore } from "./session-store.js";
import { RealmError, isKnownCode } from "./errors.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

/** Serves the platform bootstrap login; every other call goes to `handler`. */
function mk(handler: (s: Seen) => Response) {
  const calls: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    let body: Record<string, unknown> | undefined;
    if (typeof init?.body === "string" && init.body) body = JSON.parse(init.body) as Record<string, unknown>;
    if (isPlatformMint(url.pathname, init) && body?.["grant_type"] === "platform_api_key") {
      return json(200, { status: "ok", subject_type: "platform", refresh_token: "rt", access_token: "pt_x", expires_in: 300 });
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const seen: Seen = { method: init?.method ?? "GET", path: url.pathname, body, headers };
    calls.push(seen);
    return handler(seen);
  }) as typeof fetch;
  const realm = createRealm({
    sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x",
    baseUrl: "https://auth.test", origin: "https://app.test", fetch: f,
  });
  return { realm, calls };
}

const LOGIN_OK = { access_token: "a", refresh_token: "r", expires_in: 900, user: { id: "u" } };

test("SPEC4_1_8 PasswordLogin: NewPasswordOnWireOnlyWhenSet", async () => {
  const { realm, calls } = mk(() => json(200, LOGIN_OK));
  await realm.auth.passwordLogin({ identifier: "a@b.c", presented: "old" });
  await realm.auth.passwordLogin({ identifier: "a@b.c", presented: "old", newPassword: "" });
  await realm.auth.passwordLogin({ identifier: "a@b.c", presented: "tmp", newPassword: "a-much-longer-one" });
  assert.equal("new_password" in calls[0]!.body!, false);
  assert.equal("new_password" in calls[1]!.body!, false, "empty is absent");
  assert.equal(calls[2]!.body!["new_password"], "a-much-longer-one");
  assert.equal(calls[2]!.body!["presented"], "tmp");
  assert.equal("newPassword" in calls[2]!.body!, false, "no camelCase leakage");
});

test("SPEC4_10 InspectPasswordReset: anonymous-shaped POST, token in body, platform bearer, wrapped decode", async () => {
  const { realm, calls } = mk(() => json(200, { data: { expires_at: "2026-10-16T10:00:00Z" } }));
  const out = await realm.auth.inspectPasswordReset("tok123");
  assert.deepEqual(out, { expires_at: "2026-10-16T10:00:00Z" });
  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.equal(c.path, "/auth/password/reset/inspect");
  assert.deepEqual(c.body, { token: "tok123" });
  assert.equal(c.headers["authorization"], "Bearer pt_x");
  assert.ok(!c.path.includes("tok123"), "token never in the URL");
});

test("SPEC4_10 ConsumePasswordReset: body, wrapped decode, mints no session", async () => {
  const { realm, calls } = mk(() => json(200, { data: { status: "password_set" } }));
  const out = await realm.auth.consumePasswordReset("tok", "a-long-new-password");
  assert.deepEqual(calls[0]!.body, { token: "tok", new_password: "a-long-new-password" });
  assert.equal(calls[0]!.path, "/auth/password/reset");
  assert.deepEqual(out, { revokedSids: [] });
  assert.equal(calls.length, 1, "no login chained onto a consume");
});

test("SPEC4_10 ConsumePasswordReset: errors are typed and NOT retried", async () => {
  for (const [status, code] of [
    [400, "reset_token_invalid"], [410, "reset_token_expired"],
    [410, "reset_token_used"], [410, "reset_token_superseded"],
  ] as const) {
    const { realm, calls } = mk(() => json(status, { error: { code, message: code } }));
    await assert.rejects(realm.auth.consumePasswordReset("tok", "a-long-new-password"), (e: unknown) => {
      assert.ok(e instanceof RealmError);
      assert.equal(e.code, code);
      assert.equal(e.httpStatus, status);
      return true;
    });
    assert.equal(calls.length, 1, `${code}: a consume is never retried`);
  }
});

test("SPEC6_3_reset SendPasswordReset: POST, no body, wrapped 202 decode, masked address", async () => {
  const { realm, calls } = mk(() => json(202, { data: { status: "sent", to: "a***@example.com", expires_at: "2026-10-16T10:30:00Z" } }));
  const out = await realm.tenants.users.sendPasswordReset("t 1", "u/2");
  assert.deepEqual(out, { status: "sent", to: "a***@example.com", expires_at: "2026-10-16T10:30:00Z" });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/tenants/t%201/users/u%2F2/password-reset");
  assert.equal(calls[0]!.body, undefined);
});

test("SPEC6_3_reset SendPasswordReset: typed errors", async () => {
  for (const [status, code] of [[409, "no_verified_email"], [429, "reset_throttled"], [404, "user_not_found"]] as const) {
    const { realm } = mk(() => json(status, { error: { code, message: code } }));
    await assert.rejects(realm.tenants.users.sendPasswordReset("t", "u"), (e: unknown) => {
      assert.ok(e instanceof RealmError);
      assert.equal(e.code, code);
      return true;
    });
  }
});

test("SPEC6_3_credentials SetCredentials: PUT, empty fields not sent", async () => {
  const { realm, calls } = mk(() => json(200, { data: { status: "updated" } }));
  await realm.tenants.users.setCredentials("t1", "u1", { username: "alice", password: "tmp-password-1" });
  await realm.tenants.users.setCredentials("t1", "u1", { username: "alice", password: "" });
  await realm.tenants.users.setCredentials("t1", "u1", { password: "tmp-password-1" });
  assert.equal(calls[0]!.method, "PUT");
  assert.equal(calls[0]!.path, "/tenants/t1/users/u1/credentials");
  assert.deepEqual(calls[0]!.body, { username: "alice", password: "tmp-password-1" });
  assert.deepEqual(calls[1]!.body, { username: "alice" });
  assert.deepEqual(calls[2]!.body, { password: "tmp-password-1" });
});

test("SPEC6_3_credentials SetCredentials: typed errors", async () => {
  for (const code of ["reset_link_required", "verified_email_required"] as const) {
    const { realm } = mk(() => json(409, { error: { code, message: code } }));
    await assert.rejects(realm.tenants.users.setCredentials("t", "u", { password: "x" }), (e: unknown) => {
      assert.ok(e instanceof RealmError);
      assert.equal(e.code, code);
      return true;
    });
  }
});

test("SPEC3_1_password PasswordLogin: change codes typed (password_unchanged, password_change_not_required)", async () => {
  for (const code of ["password_unchanged", "password_change_not_required"] as const) {
    const { realm } = mk(() => json(400, { error: { code, message: code } }));
    await assert.rejects(
      realm.auth.passwordLogin({ identifier: "a@b.c", presented: "x", newPassword: "y" }),
      (e: unknown) => {
        assert.ok(e instanceof RealmError);
        assert.equal(e.code, code);
        return true;
      },
    );
  }
});

test("SPEC3_1_password: all ten ADR-111 codes are registered", () => {
  for (const c of [
    "password_unchanged", "password_change_not_required", "reset_link_required",
    "verified_email_required", "no_verified_email", "reset_throttled",
    "reset_token_invalid", "reset_token_expired", "reset_token_used", "reset_token_superseded",
  ]) assert.equal(isKnownCode(c), true, c);
});

test("Me SetPasswordRequestShapePerLane: direct lane bearer, BFF lane X-User-Token; current_password only when set", async () => {
  const { realm, calls } = mk(() => json(200, { data: { status: "updated" } }));
  const out = await realm.withUserToken("ub").me.setPassword({ currentPassword: "old-pass-1234", newPassword: "a-long-new-password" });
  await realm.me.setPassword({ userToken: "ut", newPassword: "a-long-new-password" });
  assert.deepEqual(out, { status: "updated", revokedSids: [] });
  assert.equal(calls[0]!.method, "PUT");
  assert.equal(calls[0]!.path, "/me/password");
  assert.equal(calls[0]!.headers["authorization"], "Bearer pt_x");
  assert.equal(calls[0]!.headers["x-user-token"], "ub");
  assert.deepEqual(calls[0]!.body, { current_password: "old-pass-1234", new_password: "a-long-new-password" });
  assert.equal(calls[1]!.headers["authorization"], "Bearer pt_x");
  assert.equal(calls[1]!.headers["x-user-token"], "ut");
  assert.deepEqual(calls[1]!.body, { new_password: "a-long-new-password" });
});

test("SPEC4_1_4_policy discovery: password_policy survives a decode and stays absent when absent", async () => {
  const { realm } = mk(() => json(200, { providers: [], credential_methods: ["password"], password_policy: { require_verified_email: false } }));
  const out = await realm.identityProviders.discover();
  assert.deepEqual(out.password_policy, { require_verified_email: false });
  const { realm: r2 } = mk(() => json(200, { providers: [] }));
  assert.equal((await r2.identityProviders.discover()).password_policy, undefined);
});
