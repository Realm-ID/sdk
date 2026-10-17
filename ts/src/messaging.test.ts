// ADR-115 bring-your-own phone delivery. Test names cite the SPEC anchors
// (SPEC6_16, SPEC3_1_channels, SPEC4_1_4a, SPECX_1_whatsapp, SPEC6_5_phone_otp)
// so a parity sweep can find each across languages.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import {
  RealmError,
  isKnownCode,
  isInvalidChannelConfig,
  isChannelValidationFailed,
  isChannelNotConfigured,
  isPhoneOtpRateLimited,
} from "./errors.js";
import { DELIVERY_MODE_WHATSAPP } from "./otp.js";
import { offersPhoneLogin } from "./identity-providers.js";
import type { IdentityProvidersResponse } from "./identity-providers.js";
import { phoneOtpConfig } from "./config.js";

interface Rec { method: string; url: string; body?: unknown; auth: string | null }

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
    const rec: Rec = { method: init?.method ?? "GET", url, body, auth: new Headers(init?.headers).get("authorization") };
    calls.push(rec);
    return handler(rec);
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  return { realm, calls };
}

const json = (status: number, v: unknown): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const readShape = {
  channel: "sms", provider: "twilio", secret_hint: "cret", status: "operational",
  status_reason: null, status_changed_at: "2026-10-17T01:00:00Z", validated_at: "2026-10-17T01:00:00Z",
  updated_at: "2026-10-17T01:00:00Z", account_sid: "AC1", api_key_sid: "SK1", from_number: "+15550001111",
};

test("SPEC6_16 putSms: PUTs the Twilio fields to /messaging/sms and decodes the bare read shape", async () => {
  const { realm, calls } = setup(() => json(200, readShape));
  const out = await realm.messaging.putSms({
    account_sid: "AC1", api_key_sid: "SK1", api_key_secret: "s3cret", from_number: "+15550001111",
  });
  const c = calls[0]!;
  assert.equal(c.method, "PUT");
  assert.match(c.url, /\/platforms\/r\/messaging\/sms$/);
  assert.deepEqual(c.body, { account_sid: "AC1", api_key_sid: "SK1", api_key_secret: "s3cret", from_number: "+15550001111" });
  assert.equal(out.channel, "sms");
  assert.equal(out.provider, "twilio");
  assert.equal(out.status, "operational");
  assert.equal(out.secret_hint, "cret");
  assert.equal(out.status_reason, null);
  assert.equal(out.status_changed_at, "2026-10-17T01:00:00Z");
  assert.equal(out.account_sid, "AC1");
  assert.equal(out.from_number, "+15550001111");
  assert.equal(out.waba_id, undefined);
  assert.ok(!("api_key_secret" in out) && !("auth_token" in out) && !("access_token" in out), "a read can never carry a secret");
});

test("SPEC6_16 putWhatsApp: PUTs the Meta fields to /messaging/whatsapp", async () => {
  const { realm, calls } = setup(() => json(200, {
    channel: "whatsapp", provider: "meta", secret_hint: "WXYZ", status: "failing", status_reason: "token revoked",
    status_changed_at: "2026-10-17T02:00:00Z", validated_at: null, updated_at: "2026-10-17T02:00:00Z",
    phone_number_id: "109", waba_id: "22", template_name: "login_code", template_language: "en",
  }));
  const out = await realm.messaging.putWhatsApp({
    phone_number_id: "109", waba_id: "22", access_token: "tok", template_name: "login_code", template_language: "en",
  });
  assert.match(calls[0]!.url, /\/platforms\/r\/messaging\/whatsapp$/);
  assert.deepEqual(Object.keys(calls[0]!.body as object).sort(),
    ["access_token", "phone_number_id", "template_language", "template_name", "waba_id"]);
  assert.equal(out.status, "failing");
  assert.equal(out.status_reason, "token revoked");
  assert.equal(out.validated_at, null);
  assert.equal(out.template_name, "login_code");
});

test("SPEC6_16 get/delete: GET and DELETE the channel route; delete returns the status", async () => {
  const { realm, calls } = setup((r) => r.method === "DELETE" ? json(200, { status: "deleted" }) : json(200, readShape));
  const got = await realm.messaging.get("sms");
  const del = await realm.messaging.delete("whatsapp");
  assert.equal(calls[0]!.method, "GET");
  assert.match(calls[0]!.url, /\/messaging\/sms$/);
  assert.equal(got.channel, "sms");
  assert.equal(calls[1]!.method, "DELETE");
  assert.match(calls[1]!.url, /\/messaging\/whatsapp$/);
  assert.equal(del.status, "deleted");
});

test("SPEC6_16 an unknown channel is rejected before the network", async () => {
  const { realm, calls } = setup(() => json(200, readShape));
  // @ts-expect-error the channel type is closed
  await assert.rejects(() => realm.messaging.get("../signing-keys"), (e) => e instanceof RealmError && e.code === "bad_request");
  // @ts-expect-error the channel type is closed
  await assert.rejects(() => realm.messaging.delete("email"), (e) => e instanceof RealmError && e.code === "bad_request");
  assert.equal(calls.length, 0);
});

test("SPEC6_16 a malformed read body is a typed error, not a half-built object", async () => {
  const { realm } = setup(() => json(200, { channel: "sms" }));
  await assert.rejects(() => realm.messaging.get("sms"), (e) => e instanceof RealmError);
});

test("SPEC3_1_channels the four codes are registered and land on err.code", async () => {
  for (const c of ["invalid_channel_config", "channel_validation_failed", "channel_not_configured", "phone_otp_rate_limited"]) {
    assert.ok(isKnownCode(c), c);
  }
  const cases: Array<[number, string, (e: unknown) => boolean]> = [
    [400, "invalid_channel_config", isInvalidChannelConfig],
    [422, "channel_validation_failed", isChannelValidationFailed],
    [404, "channel_not_configured", isChannelNotConfigured],
    [429, "phone_otp_rate_limited", isPhoneOtpRateLimited],
  ];
  for (const [status, code, is] of cases) {
    const { realm } = setup(() => json(status, { error: { code, message: "m" } }));
    await assert.rejects(() => realm.messaging.get("sms"), (e) => {
      assert.ok(e instanceof RealmError);
      assert.equal(e.code, code);
      assert.equal(e.details?.["server_code"], undefined, "registered codes are not duplicated into server_code");
      return is(e);
    });
  }
  assert.equal(isPhoneOtpRateLimited(new RealmError({ code: "rate_limited", message: "x", httpStatus: 429 })), false);
});

test("SPEC3_1_channels delivery_unavailable stays unregistered and carries details.channel", async () => {
  assert.equal(isKnownCode("delivery_unavailable"), false);
  assert.equal(isKnownCode("channel_unavailable"), false);
  const { realm } = setup(() => json(503, { error: { code: "delivery_unavailable", message: "whatsapp is not available", channel: "whatsapp" } }));
  await assert.rejects(
    () => realm.otp.issue({ subjectRef: "user:u1", purpose: "login", deliveryMode: DELIVERY_MODE_WHATSAPP, userBearer: "jwt" }),
    (e) => e instanceof RealmError && e.httpStatus === 503 && e.details?.["server_code"] === "delivery_unavailable" && e.details?.["channel"] === "whatsapp",
  );
});

test("SPECX_1_whatsapp otp.issue sends delivery_mode whatsapp and reports delivered", async () => {
  const { realm, calls } = setup(() => json(200, {
    id: "o1", delivered: "whatsapp", expires_at: "2026-10-17T03:00:00Z", purpose: "login", subject_ref: "user:u1",
  }));
  assert.equal(DELIVERY_MODE_WHATSAPP, "whatsapp");
  const out = await realm.otp.issue({ subjectRef: "user:u1", purpose: "login", deliveryMode: DELIVERY_MODE_WHATSAPP, userBearer: "jwt" });
  assert.equal((calls[0]!.body as Record<string, unknown>)["delivery_mode"], "whatsapp");
  assert.equal(out.delivered, "whatsapp");
});

test("SPEC4_1_4a phone_channels: absent is distinguishable from [] and survives a round trip", async () => {
  const mk = (body: unknown) => setup(() => json(200, body)).realm.identityProviders.discover();
  const withList = await mk({ providers: [], credential_methods: ["otp"], phone_channels: ["whatsapp", "sms"] });
  assert.deepEqual(withList.phone_channels, ["whatsapp", "sms"]);
  assert.deepEqual(JSON.parse(JSON.stringify(withList)).phone_channels, ["whatsapp", "sms"]);
  assert.equal(offersPhoneLogin(withList), true);

  const empty = await mk({ providers: [], credential_methods: ["otp"], phone_channels: [] });
  assert.deepEqual(empty.phone_channels, []);
  assert.deepEqual(JSON.parse(JSON.stringify(empty)).phone_channels, []);
  assert.equal(offersPhoneLogin(empty), false);

  const absent = await mk({ providers: [], credential_methods: ["otp"] });
  assert.equal(absent.phone_channels, undefined);
  assert.ok(!("phone_channels" in JSON.parse(JSON.stringify(absent))));
  assert.equal(offersPhoneLogin(absent), false, "an older issuer offers nothing");

  const noOtp = await mk({ providers: [], credential_methods: ["password"], phone_channels: ["sms"] });
  assert.equal(offersPhoneLogin(noOtp), false, "phone_channels without otp offers nothing");
  const typed: IdentityProvidersResponse = { providers: [], phone_channels: ["sms"] };
  assert.equal(offersPhoneLogin(typed), false);
});

test("SPEC6_5_phone_otp phoneOtpConfig reads the group, and is undefined rather than a zeroed object", () => {
  assert.deepEqual(phoneOtpConfig({ phone_otp: { max_per_window: 5, window_seconds: 900 } }), { max_per_window: 5, window_seconds: 900 });
  assert.equal(phoneOtpConfig({}), undefined);
  assert.equal(phoneOtpConfig({ phone_otp: "garbage" }), undefined);
  assert.equal(phoneOtpConfig({ phone_otp: { max_per_window: 5 } }), undefined);
  assert.equal(phoneOtpConfig({ phone_otp: { max_per_window: "5", window_seconds: 900 } }), undefined);
});
