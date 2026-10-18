// SPEC §X.4a / §3.1 / §6.5 (issuer ADR-116): auth.sendLoginCode, the three
// sign-in code send codes, the helpers, and phone_otp.sign_in_per_ip_per_hour.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { RealmError, isKnownCode, isSignInIpRateLimited, isDeliveryUnavailable, isPhoneOtpRateLimited } from "./errors.js";
import { phoneOtpConfig } from "./config.js";
import * as sdk from "./index.js";

interface Rec { method: string; url: string; body?: unknown; headers: Headers }

function setup(handler: (r: Rec) => Response): { realm: ReturnType<typeof createRealm>; calls: Rec[] } {
  const calls: Rec[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/login")) {
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

test("SPECX_4a sendLoginCode: POSTs /auth/otp/send-login with the platform token and decodes the BARE body", async () => {
  const { realm, calls } = setup(() => json(202, { sent_if_registered: true }));
  const out = await realm.auth.sendLoginCode({
    identifier: "+919999000011", deliveryMode: "sms", tenantId: "t-1", onBehalfOfIp: "203.0.113.9",
  });
  assert.deepEqual(out, { sentIfRegistered: true });
  const c = calls[0]!;
  assert.equal(c.method, "POST");
  assert.match(c.url, /\/auth\/otp\/send-login$/);
  assert.equal(c.headers.get("authorization"), "Bearer pt_x");
  assert.equal(c.headers.get("x-on-behalf-of-ip"), "203.0.113.9");
  assert.deepEqual(c.body, { identifier: "+919999000011", delivery_mode: "sms", tenant_id: "t-1" });
});

test("SPECX_4a sendLoginCode: tenantId and the IP header are omitted when not given", async () => {
  const { realm, calls } = setup(() => json(202, { sent_if_registered: true }));
  await realm.auth.sendLoginCode({ identifier: "+919999000011", deliveryMode: "whatsapp" });
  const c = calls[0]!;
  assert.deepEqual(c.body, { identifier: "+919999000011", delivery_mode: "whatsapp" });
  assert.equal(c.headers.get("x-on-behalf-of-ip"), null);
});

test("SPEC3_1_signin the three codes are registered and land on err.code, not details.server_code", async () => {
  const cases: Array<[number, string]> = [
    [429, "sign_in_ip_rate_limited"], [403, "method_not_enabled"], [400, "invalid_on_behalf_of_ip"],
  ];
  for (const [status, code] of cases) {
    assert.ok(isKnownCode(code), code);
    const { realm } = setup(() => json(status, { error: { code, message: "m" } }));
    await assert.rejects(() => realm.auth.sendLoginCode({ identifier: "+919999000011", deliveryMode: "sms" }), (e) => {
      assert.ok(e instanceof RealmError);
      assert.equal(e.code, code);
      assert.equal(e.details?.["server_code"], undefined, "registered codes are not duplicated into server_code");
      return true;
    });
  }
});

test("SPEC3_1_signin method_not_enabled on a domain-SSO 400 is now err.code (behaviour change)", async () => {
  const { realm } = setup(() => json(400, { error: { code: "method_not_enabled", message: "off" } }));
  await assert.rejects(() => realm.auth.sendLoginCode({ identifier: "+919999000011", deliveryMode: "sms" }), (e) =>
    e instanceof RealmError && e.code === "method_not_enabled" && e.httpStatus === 400 && e.details?.["server_code"] === undefined);
});

test("SPEC3_1_signin isSignInIpRateLimited / isDeliveryUnavailable", async () => {
  const mk = (code: string, status: number) => new RealmError({ code: code as never, message: "m", httpStatus: status });
  assert.equal(isSignInIpRateLimited(mk("sign_in_ip_rate_limited", 429)), true);
  assert.equal(isSignInIpRateLimited(mk("phone_otp_rate_limited", 429)), false);
  assert.equal(isSignInIpRateLimited(undefined), false);
  assert.equal(isPhoneOtpRateLimited(mk("sign_in_ip_rate_limited", 429)), false);

  assert.equal(isKnownCode("delivery_unavailable"), false);
  const { realm } = setup(() => json(503, { error: { code: "delivery_unavailable", message: "m", channel: "sms" } }));
  await assert.rejects(() => realm.auth.sendLoginCode({ identifier: "+919999000011", deliveryMode: "sms" }), (e) =>
    isDeliveryUnavailable(e) && (e as RealmError).details?.["server_code"] === "delivery_unavailable");
  assert.equal(isDeliveryUnavailable(new RealmError({ code: "bad_request", message: "m", httpStatus: 400 })), false);
  assert.equal(isDeliveryUnavailable("nope"), false);
  assert.equal(typeof sdk.isSignInIpRateLimited, "function");
  assert.equal(typeof sdk.isDeliveryUnavailable, "function");
});

test("SPEC6_5_phone_otp phoneOtpConfig reads sign_in_per_ip_per_hour", () => {
  const got = phoneOtpConfig({ phone_otp: { max_per_window: 5, window_seconds: 900, sign_in_per_ip_per_hour: 10 } });
  assert.deepEqual(got, { max_per_window: 5, window_seconds: 900, sign_in_per_ip_per_hour: 10 });
});
