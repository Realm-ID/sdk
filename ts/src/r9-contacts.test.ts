// R7+R9 (issuer ADR-117, spec 0.62.0): contacts.unique_kinds config, contact
// proof, invitation inspect/accept/resend, and the new error codes.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { RealmError, isKnownCode, ERROR_CODES } from "./errors.js";
import { contactsConfig } from "./config.js";

interface Rec { method: string; url: string; body?: unknown; headers: Headers }

function setup(handler: (r: Rec) => Response): { realm: ReturnType<typeof createRealm>; calls: Rec[] } {
  const calls: Rec[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/login") && init?.method === "POST" && String(init.body).includes("api_key")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok", access_token: "pt_x", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) body = JSON.parse(init.body);
    const rec: Rec = { method: init?.method ?? "GET", url, body, headers: new Headers(init?.headers) };
    calls.push(rec);
    return handler(rec);
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  return { realm, calls };
}

const json = (status: number, v: unknown): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("R9 config.get: contactsConfig reads the resolved list, uniqueKindsReport rides beside config", async () => {
  const { realm } = setup(() => json(200, {
    id: "r",
    config: { contacts: { unique_kinds: ["phone"] } },
    unique_kinds_report: { email: { values_on_multiple_memberships: 2 }, phone: { values_on_multiple_memberships: 0 } },
  }));
  const got = await realm.config.get();
  assert.deepEqual(contactsConfig(got.config), { unique_kinds: ["phone"] });
  assert.deepEqual(got.uniqueKindsReport, { email: { valuesOnMultipleMemberships: 2 }, phone: { valuesOnMultipleMemberships: 0 } });
});

test("R9 config.get: an empty list reads [] and an absent report is undefined (not zero)", async () => {
  const { realm } = setup(() => json(200, { id: "r", config: { contacts: { unique_kinds: [] } } }));
  const got = await realm.config.get();
  assert.deepEqual(contactsConfig(got.config), { unique_kinds: [] });
  assert.equal(got.uniqueKindsReport, undefined);
  assert.equal(contactsConfig({}), undefined);
});

test("R9 config.update: confirmLockout rides as the QUERY parameter, never a header; null unique_kinds passes through", async () => {
  const { realm, calls } = setup(() => json(200, { id: "r" }));
  await realm.config.update({ contacts: { unique_kinds: ["phone"] } }, { confirmLockout: true });
  assert.equal(calls[0]!.method, "PATCH");
  assert.match(calls[0]!.url, /\/platforms\/r\/config\?confirm_lockout=true$/);
  assert.deepEqual(calls[0]!.body, { contacts: { unique_kinds: ["phone"] } });
  assert.equal(calls[0]!.headers.get("confirm-lockout"), null);
  await realm.config.update({ contacts: { unique_kinds: null } });
  assert.match(calls[1]!.url, /\/platforms\/r\/config$/);
});

test("R9 me.sendContactProof: POST /me/contacts/{id}/proof with delivery_mode, decodes {delivered}", async () => {
  const { realm, calls } = setup(() => json(200, { delivered: "sms" }));
  const out = await realm.me.sendContactProof({ contactId: "c 1", deliveryMode: "sms", userBearer: "ujwt" });
  assert.deepEqual(out, { delivered: "sms" });
  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.match(c.url, /\/me\/contacts\/c%201\/proof$/);
  assert.deepEqual(c.body, { delivery_mode: "sms" });
  assert.equal(c.headers.get("authorization"), "Bearer ujwt");
});

test("R9 me.confirmContactProof: POST .../proof/confirm with the code, decodes the contact", async () => {
  const { realm, calls } = setup(() => json(200, { id: "c1", kind: "phone", value: "+919999000011", verified: true, verified_at: "2026-10-19T00:00:00Z" }));
  const out = await realm.me.confirmContactProof({ contactId: "c1", code: "123456", userToken: "vjwt" });
  assert.deepEqual(out, { id: "c1", kind: "phone", value: "+919999000011", verified: true, verifiedAt: "2026-10-19T00:00:00Z" });
  const c = calls[0]!;
  assert.match(c.url, /\/me\/contacts\/c1\/proof\/confirm$/);
  assert.deepEqual(c.body, { code: "123456" });
  assert.equal(c.headers.get("x-user-token"), "vjwt");
});

test("R9 auth.inspectInvitation: token goes in the BODY of POST /auth/invitations/inspect", async () => {
  const { realm, calls } = setup(() => json(200, { tenant_id: "t1", tenant_display_name: "Acme", expires_at: "2026-10-26T00:00:00Z" }));
  const out = await realm.auth.inspectInvitation("tok-1");
  assert.deepEqual(out, { tenantId: "t1", tenantDisplayName: "Acme", expiresAt: "2026-10-26T00:00:00Z" });
  assert.match(calls[0]!.url, /\/auth\/invitations\/inspect$/);
  assert.deepEqual(calls[0]!.body, { token: "tok-1" });
  assert.ok(!calls[0]!.url.includes("tok-1"));
});

test("R9 auth.acceptInvitation: returns the password-grant LoginResponse type, MFA challenge included", async () => {
  // Same completion code as the password grant, so the challenge surfaces the way
  // passwordLogin's does: RealmError mfa_required with the token in details.
  const { realm, calls } = setup(() => json(412, {
    error: { code: "mfa_required", message: "MFA required" }, mfa_challenge_token: "chal-1", methods: ["totp"],
  }));
  await assert.rejects(
    () => realm.auth.acceptInvitation({ token: "tok-1", username: "alice", password: "correct horse battery" }),
    (e) => e instanceof RealmError && e.code === "mfa_required" && e.details?.["mfa_challenge_token"] === "chal-1",
  );
  assert.match(calls[0]!.url, /\/auth\/invitations\/accept$/);
  assert.deepEqual(calls[0]!.body, { token: "tok-1", username: "alice", password: "correct horse battery" });
});

test("R9 auth.acceptInvitation: a success carries tokens and revokedSids", async () => {
  const { realm } = setup(() => json(200, {
    status: "ok", subject_type: "user", access_token: "at", refresh_token: "rt", expires_in: 300, tenant_id: "t1", revoked_sids: [],
  }));
  const out = await realm.auth.acceptInvitation({ token: "tok-1", username: "alice", password: "pw" });
  assert.equal(out.accessToken, "at");
  assert.deepEqual(out.revokedSids, []);
});

test("R9 tenants.invitations.resend: POST .../resend, answers the invite", async () => {
  const { realm, calls } = setup(() => json(200, { id: "i1", identifier: "a@b.co", status: "pending" }));
  const inv = await realm.tenants.invitations.resend("t 1", "i1");
  assert.equal(inv.id, "i1");
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\/tenants\/t%201\/invitations\/i1\/resend$/);
});

const NEW_CODES = [
  "unique_kinds_requires_password", "password_login_required", "unique_kind_lockout",
  "unique_kind_lockout_check_failed", "unique_kind_duplicates", "email_keyed_signin_enabled",
  "require_verified_email_conflict", "idp_requires_identifying_email", "idp_requires_identifying_phone",
  "domain_sso_requires_unique_email", "invite_contact_not_identifying", "recipient_email_not_identifying",
  "invalid_invitation_token", "contact_not_found", "contact_already_verified", "contact_changed",
  "reset_email_not_identifying",
];

test("R9 every spec 3.2 new code is registered and lands on err.code with its body siblings in details", async () => {
  assert.equal(NEW_CODES.length, 17);
  for (const code of NEW_CODES) {
    assert.ok(isKnownCode(code), code);
    assert.ok(ERROR_CODES.includes(code as never), code);
  }
  const { realm } = setup(() => json(409, { error: { code: "unique_kind_lockout", message: "m", details: { kind: "email", locked_out: 3, mfa_locked_out: 1 } } }));
  await assert.rejects(() => realm.config.update({ contacts: { unique_kinds: ["phone"] } }), (e) => {
    assert.ok(e instanceof RealmError);
    assert.equal(e.code, "unique_kind_lockout");
    assert.equal(e.details?.["server_code"], undefined);
    return true;
  });
});
