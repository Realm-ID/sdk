import { test } from "node:test";
import { createMemorySessionStore } from "./session-store.js";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";
import { DELIVERY_MODE_VIEW_BFF } from "./otp.js";
import { isPlatformMint, platformMintResponse } from "./auth-mint-helpers.test.js";

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

    if (isPlatformMint(url, init)) {
      return platformMintResponse("pt_test");
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
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  const out = await realm.withUserToken("user-jwt").otp.issue({
    subjectRef: "booking:X",
    purpose: "delivery"
  });
  assert.equal(out.id, "otp-1");
  assert.equal(out.value, "123456");
  assert.equal(out.expiresAt, "2026-05-08T12:00:00Z");

  const issueCall = calls.find((c) => c.url.endsWith("/auth/otp/issue"))!;
  assert.equal((issueCall.body as Record<string, unknown>).subject_ref, "booking:X");
  assert.equal(issueCall.headers.get("authorization"), "Bearer pt_test");
  assert.equal(issueCall.headers.get("x-user-token"), "user-jwt");
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
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  const out = await realm.withUserToken("agent-svc-jwt").otp.verify({
    subjectRef: "booking:X",
    purpose: "delivery",
    presented: "123456"
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
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  await assert.rejects(
    () => realm.withUserToken("agent-svc-jwt").otp.verify({
      subjectRef: "booking:X", purpose: "delivery", presented: "wrong"
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
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  const out = await realm.withUserToken("manager-jwt").otp.view("otp-1");
  assert.equal(out.value, "654321");
  assert.equal(out.issuerUserId, "manager-A");
});

test("otp.issue: threads delivery_mode=view_bff onto the issue body (ADR-071 §4)", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      id: "otp-1",
      value: "123456",
      expires_at: "2026-07-14T00:00:00Z",
      purpose: "login",
      subject_ref: "user:sa-1",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  await realm.withUserToken("owner-jwt").otp.issue({
    subjectRef: "user:sa-1",
    purpose: "login",
    deliveryMode: DELIVERY_MODE_VIEW_BFF
  });
  const body = calls.find((c) => c.url.endsWith("/auth/otp/issue"))!.body as Record<string, unknown>;
  assert.equal(body["delivery_mode"], "view_bff");
});

test("otp.issue: omits delivery_mode when unset", async () => {
  const { fetch, calls } = recorder([
    () => new Response(JSON.stringify({
      id: "otp-2", value: "222222", expires_at: "2026-07-14T00:00:00Z",
      purpose: "delivery", subject_ref: "booking:X",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  ]);
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: REALM_ID, apiKey: API_KEY, baseUrl: "https://auth.test", fetch });
  await realm.withUserToken("u").otp.issue({ subjectRef: "booking:X", purpose: "delivery" });
  const body = calls.find((c) => c.url.endsWith("/auth/otp/issue"))!.body as Record<string, unknown>;
  assert.equal("delivery_mode" in body, false);
});
