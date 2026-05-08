import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function recorder(handlers: Array<(rec: Recorded) => Response | Promise<Response>>): {
  fetch: typeof fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = init.body; }
    }
    const rec: Recorded = { url, method: init?.method ?? "GET", headers, body };
    calls.push(rec);

    if (url.endsWith("/auth/login")) {
      return new Response(JSON.stringify({
        platform_token: "pt_test",
        expires_in: 300,
        realm_id: "01HREALM",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const h = handlers[i++] ?? handlers[handlers.length - 1]!;
    return h(rec);
  }) as typeof fetch;
  return { fetch, calls };
}

const REALM_ID = "01HREALM";
const API_KEY = "rk_live_test";

test("otp.issue: posts subject_ref + purpose, returns response", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      id: "otp-1",
      value: "123456",
      expires_at: "2026-05-08T12:00:00Z",
      purpose: "delivery",
      subject_ref: "booking:X",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  const out = await realm.otp.issue({
    subjectRef: "booking:X",
    purpose: "delivery",
    userBearer: "user-jwt",
  });
  assert.equal(out.id, "otp-1");
  assert.equal(out.value, "123456");
  assert.equal(out.expiresAt, "2026-05-08T12:00:00Z");

  const issueCall = calls.find((c) => c.url.endsWith("/auth/otp/issue"))!;
  assert.equal((issueCall.body as Record<string, unknown>).subject_ref, "booking:X");
  assert.equal(issueCall.headers.get("authorization"), "Bearer user-jwt");
});

test("otp.verify: success returns issuer attribution", async () => {
  const { fetch } = recorder([
    () => new Response(JSON.stringify({
      otp_id: "otp-1",
      issuer_user_id: "manager-A",
      issued_at: "2026-05-08T11:00:00Z",
      subject_ref: "booking:X",
      purpose: "delivery",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  const out = await realm.otp.verify({
    subjectRef: "booking:X",
    purpose: "delivery",
    presented: "123456",
    userBearer: "agent-svc-jwt",
  });
  assert.equal(out.otpId, "otp-1");
  assert.equal(out.issuerUserId, "manager-A");
});

test("otp.verify: invalid surfaces invalid_otp", async () => {
  const { fetch } = recorder([
    () => new Response(JSON.stringify({
      error: { code: "invalid_otp", message: "invalid OTP" },
    }), { status: 401, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  await assert.rejects(
    () => realm.otp.verify({
      subjectRef: "booking:X", purpose: "delivery", presented: "wrong",
      userBearer: "agent-svc-jwt",
    }),
    (err) => err instanceof RealmError && err.code === "invalid_otp",
  );
});

test("otp.view: returns issuerUserId", async () => {
  const { fetch } = recorder([
    () => new Response(JSON.stringify({
      id: "otp-1",
      value: "654321",
      expires_at: "2026-05-08T12:00:00Z",
      purpose: "login",
      subject_ref: "user:bob",
      issuer_user_id: "manager-A",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  const out = await realm.otp.view("otp-1", { userBearer: "manager-jwt" });
  assert.equal(out.value, "654321");
  assert.equal(out.issuerUserId, "manager-A");
});
