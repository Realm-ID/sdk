import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

// Records the last non-login request's method/url/body so each test can assert
// the wire. The /auth/login leg always mints the platform token "pt_x".
function mkFetch(status: number, body: unknown, sink?: { method?: string; url?: string; body?: unknown }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (sink) {
      sink.method = init?.method;
      sink.url = url;
      sink.body = init?.body ? JSON.parse(init.body as string) : undefined;
    }
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const cfg = { realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test" };

test("sessions.revokeUser: POST /tenants/{id}/users/{uid}/sessions/revoke", async () => {
  const sink: { method?: string; url?: string } = {};
  const realm = createRealm({ ...cfg, fetch: mkFetch(200, { status: "ok", revoked: 3 }, sink) });
  const out = await realm.sessions.revokeUser("t1", "u9");
  assert.equal(sink.method, "POST");
  assert.match(sink.url!, /\/tenants\/t1\/users\/u9\/sessions\/revoke$/);
  assert.equal(out.revoked, 3);
});

test("sessions.revokeAll: POST /platforms/{realmId}/sessions/revoke-all", async () => {
  const sink: { url?: string } = {};
  const realm = createRealm({ ...cfg, fetch: mkFetch(200, { status: "ok", revoked: 42 }, sink) });
  const out = await realm.sessions.revokeAll();
  assert.match(sink.url!, /\/platforms\/r\/sessions\/revoke-all$/);
  assert.equal(out.revoked, 42);
});

test("users.delinkContact: POST .../contacts/{contactId}/delink", async () => {
  const sink: { method?: string; url?: string } = {};
  const realm = createRealm({ ...cfg, fetch: mkFetch(200, { status: "delinked", contact_id: "c7", revoked_bindings: 1 }, sink) });
  const out = await realm.tenants.users.delinkContact("t1", "u1", "c7");
  assert.equal(sink.method, "POST");
  assert.match(sink.url!, /\/tenants\/t1\/users\/u1\/contacts\/c7\/delink$/);
  assert.equal(out.status, "delinked");
  assert.equal(out.revoked_bindings, 1);
});

test("users.handBack: POST .../hand-back with {from_user_id}", async () => {
  const sink: { body?: unknown } = {};
  const realm = createRealm({ ...cfg, fetch: mkFetch(200, { status: "handed_back", user_id: "old", email: "u@corp.test" }, sink) });
  const out = await realm.tenants.users.handBack("t1", "old", "new");
  assert.deepEqual(sink.body, { from_user_id: "new" });
  assert.equal(out.user_id, "old");
  assert.equal(out.email, "u@corp.test");
});

test("driftReviews.reject: soft (no body) then rejectHard sends {hard:true}", async () => {
  const softSink: { body?: unknown } = {};
  const soft = createRealm({ ...cfg, fetch: mkFetch(200, { id: "rv1", status: "rejected", mode: "soft" }, softSink) });
  const s = await soft.tenants.driftReviews.reject("t1", "rv1");
  assert.equal(s.mode, "soft");
  assert.equal(softSink.body, undefined);

  const hardSink: { body?: unknown } = {};
  const hard = createRealm({ ...cfg, fetch: mkFetch(200, { id: "rv1", status: "rejected", mode: "hard", parked: true, revoked_bindings: 2 }, hardSink) });
  const h = await hard.tenants.driftReviews.rejectHard("t1", "rv1");
  assert.equal(h.mode, "hard");
  assert.equal(h.parked, true);
  assert.equal(h.revoked_bindings, 2);
  assert.deepEqual(hardSink.body, { hard: true });
});

test("auth.listAuthenticators: GET /auth/mfa/authenticators", async () => {
  const sink: { method?: string; url?: string } = {};
  const realm = createRealm({ ...cfg, fetch: mkFetch(200, {
    authenticators: [{ type: "totp", confirmed: true, created_at: 1000, confirmed_at: 1001 }],
    backup_codes_remaining: 8,
  }, sink) });
  const out = await realm.auth.listAuthenticators({ userBearer: "u-jwt" });
  assert.equal(sink.method, "GET");
  assert.match(sink.url!, /\/auth\/mfa\/authenticators$/);
  assert.equal(out.backup_codes_remaining, 8);
  assert.equal(out.authenticators[0]!.type, "totp");
});

test("auth.regenerateRecoveryCodes: POST /auth/mfa/recovery/regenerate", async () => {
  const realm = createRealm({ ...cfg, fetch: mkFetch(200, { status: "ok", recovery_codes: ["aaaa-1111", "bbbb-2222"] }) });
  const out = await realm.auth.regenerateRecoveryCodes({ userBearer: "u-jwt" });
  assert.equal(out.status, "ok");
  assert.equal(out.recovery_codes.length, 2);
});

test("auth.regenerateRecoveryCodes: 412 surfaces mfa_required", async () => {
  const realm = createRealm({ ...cfg, fetch: mkFetch(412, { error: "fresh TOTP required", code: "mfa_required" }) });
  await assert.rejects(() => realm.auth.regenerateRecoveryCodes({ userBearer: "u-jwt" }),
    (e: Error) => e instanceof RealmError && e.code === "mfa_required");
});

test("login: contact_admin_required (409, flat envelope) decodes to code", async () => {
  // The platform_api_key leg mints the token; the user provider_token leg 409s
  // with the real issuer FLAT envelope: { "error": "<msg string>", "code": ... }.
  const realm = createRealm({ ...cfg, fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const gt = init?.body ? (JSON.parse(init.body as string) as { grant_type?: string }).grant_type : undefined;
    if (url.endsWith("/auth/login") && gt === "platform_api_key") {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ error: "this identifier is managed by your organisation; contact your admin", code: "contact_admin_required" }),
      { status: 409, headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  await assert.rejects(() => realm.auth.login({ method: "google", providerToken: "x", tenantId: "t1" }),
    (e: Error) => e instanceof RealmError && e.code === "contact_admin_required");
});
