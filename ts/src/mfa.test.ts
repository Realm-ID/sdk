import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

interface Captured {
  method: string;
  url: string;
  body?: unknown;
  authorization?: string;
}

function mkFetch(handler: (req: Captured) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    let body: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const headers = new Headers(init?.headers);
    return handler({ method, url, body, authorization: headers.get("authorization") ?? undefined });
  }) as typeof fetch;
}

const REALM = { realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test" } as const;

test("auth.selfEnrollMfa: refresh-authed POST to /auth/mfa/enroll, platform bearer, refresh+tenant in body, surfaces challenge", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/auth\/mfa\/enroll$/);
    // Refresh-authed (ADR-061): platform token is the bearer (auto-attached,
    // exactly like /auth/token); refresh + tenant ride the body.
    assert.equal(req.authorization, "Bearer pt_x");
    assert.deepEqual(req.body, { refresh_token: "rt-123", tenant_id: "t1" });
    return new Response(JSON.stringify({
      secret: "BASE32SECRET",
      qr_url: "otpauth://totp/x",
      recovery_codes: ["a", "b"],
      mfa_challenge_token: "enroll-chal-xyz",
      tenant_id: "t1",
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...REALM, fetch });
  const out = await realm.auth.selfEnrollMfa({ refreshToken: "rt-123", tenantId: "t1" });
  assert.equal(out.secret, "BASE32SECRET");
  assert.equal(out.qrUrl, "otpauth://totp/x");
  assert.deepEqual(out.recoveryCodes, ["a", "b"]);
  // Enroll-scoped challenge surfaced for the caller to complete via mfaVerify.
  assert.equal(out.mfaChallengeToken, "enroll-chal-xyz");
  assert.equal(out.tenantId, "t1");
});

test("auth.selfEnrollMfa: includes method when set, defaults recovery codes to []", async () => {
  const fetch = mkFetch((req) => {
    assert.deepEqual(req.body, { refresh_token: "rt-123", tenant_id: "t1", method: "totp" });
    return new Response(JSON.stringify({
      secret: "s", qr_url: "u", mfa_challenge_token: "c", tenant_id: "t1",
    }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...REALM, fetch });
  const out = await realm.auth.selfEnrollMfa({ refreshToken: "rt-123", tenantId: "t1", method: "totp" });
  assert.deepEqual(out.recoveryCodes, []);
  assert.equal(out.mfaChallengeToken, "c");
});

test("auth.selfEnrollMfa: enroll challenge completes via mfaVerify (no separate confirm step)", async () => {
  const fetch = mkFetch((req) => {
    if (/\/auth\/mfa\/enroll$/.test(req.url)) {
      return new Response(JSON.stringify({
        secret: "s", qr_url: "u", recovery_codes: ["x"],
        mfa_challenge_token: "enroll-chal-xyz", tenant_id: "t1",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Confirmation folds into the existing verify path using the
    // enroll-scoped challenge — no /auth/mfa/confirm exists anymore.
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/auth\/mfa\/verify$/);
    assert.equal((req.body as Record<string, unknown>).mfa_challenge_token, "enroll-chal-xyz");
    assert.equal((req.body as Record<string, unknown>).code, "123456");
    return new Response(JSON.stringify({
      access_token: "at", refresh_token: "rt2", expires_in: 300,
      user: { id: "u1" }, tenants: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const realm = createRealm({ ...REALM, fetch });
  const enroll = await realm.auth.selfEnrollMfa({ refreshToken: "rt-123", tenantId: "t1" });
  const session = await realm.auth.mfaVerify({ challengeToken: enroll.mfaChallengeToken, code: "123456" });
  assert.equal(session.accessToken, "at");
  assert.equal(session.refreshToken, "rt2");
});

test("auth.selfEnrollMfa: 409 already_enrolled surfaces as RealmError(conflict)", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "conflict", message: "already enrolled" },
  }), { status: 409, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...REALM, fetch });
  await assert.rejects(() => realm.auth.selfEnrollMfa({ refreshToken: "rt-123", tenantId: "t1" }), (e: Error) =>
    e instanceof RealmError && e.code === "conflict" && e.httpStatus === 409);
});

test("auth.disableMfa: DELETE /auth/mfa with code body, returns void", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "DELETE");
    assert.match(req.url, /\/auth\/mfa$/);
    assert.deepEqual(req.body, { code: "999000" });
    return new Response(JSON.stringify({ status: "disabled" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...REALM, fetch });
  const out = await realm.auth.disableMfa({ userBearer: "user_jwt", code: "999000" });
  assert.equal(out, undefined);
});

test("auth.disableMfa: 400 not_enrolled surfaces as RealmError", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "bad_request", message: "not enrolled" },
  }), { status: 400, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...REALM, fetch });
  await assert.rejects(() => realm.auth.disableMfa({ userBearer: "user_jwt", code: "x" }), (e: Error) =>
    e instanceof RealmError && e.httpStatus === 400);
});

test("auth.revokeAllSessions: DELETE /auth/sessions with no body, returns void", async () => {
  const fetch = mkFetch((req) => {
    assert.equal(req.method, "DELETE");
    assert.match(req.url, /\/auth\/sessions$/);
    assert.equal(req.body, undefined);
    assert.equal(req.authorization, "Bearer user_jwt");
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const realm = createRealm({ ...REALM, fetch });
  const out = await realm.auth.revokeAllSessions({ userBearer: "user_jwt" });
  assert.equal(out, undefined);
});

test("auth.revokeAllSessions: 403 insufficient_scope surfaces as RealmError", async () => {
  const fetch = mkFetch(() => new Response(JSON.stringify({
    error: { code: "forbidden", message: "revocation token cannot revoke sessions" },
  }), { status: 403, headers: { "content-type": "application/json" } }));
  const realm = createRealm({ ...REALM, fetch });
  await assert.rejects(() => realm.auth.revokeAllSessions({ userBearer: "rev_jwt" }), (e: Error) =>
    e instanceof RealmError && e.httpStatus === 403);
});
