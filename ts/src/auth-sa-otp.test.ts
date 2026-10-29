import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";
import { isPlatformMint, platformMintResponse } from "./auth-mint-helpers.test.js";

// Owner ruling Q3 (2026-10-29): a service account pairs by OTP in ONE call to /auth/token with a
// REQUIRED tenant_id; /auth/login stays people-only.

function fakeIssuer(): { fetch: typeof fetch; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (isPlatformMint(url, init as { body?: unknown })) return platformMintResponse();
    calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(
      JSON.stringify({ access_token: "atok", refresh_token: "rtok", expires_in: 900, subject_type: "service", tenant_id: "t1", role: "member" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetch: f, calls };
}

function realmOn(fetch: typeof globalThis.fetch) {
  return createRealm({ sessionStore: createMemorySessionStore(), realmId: "01HREALM", apiKey: "rk_live_test123", baseUrl: "https://auth.test", fetch, origin: "https://app.example" });
}

test("auth.serviceAccountOtpLogin: ONE call to /auth/token with grant_type=otp and tenant_id", async () => {
  const { fetch, calls } = fakeIssuer();
  const out = await realmOn(fetch).auth.serviceAccountOtpLogin({ identifier: "bot@example.com", presented: "123456", tenantId: "t1" });
  assert.equal(out.accessToken, "atok");
  assert.equal(out.refreshToken, "rtok");
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.endsWith("/auth/token"), calls[0]!.url);
  assert.equal(calls[0]!.body["grant_type"], "otp");
  assert.equal(calls[0]!.body["tenant_id"], "t1");
  assert.equal(calls[0]!.body["identifier"], "bot@example.com");
  assert.equal(calls[0]!.body["presented"], "123456");
});

test("auth.serviceAccountOtpLogin: a missing tenantId is refused before any request", async () => {
  const { fetch, calls } = fakeIssuer();
  await assert.rejects(
    realmOn(fetch).auth.serviceAccountOtpLogin({ identifier: "b", presented: "1", tenantId: "" }),
    (e: unknown) => e instanceof RealmError && e.details?.["server_code"] === "missing_tenant_id",
  );
  assert.equal(calls.length, 0);
});
