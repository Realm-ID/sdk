import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";
import { createMemorySessionStore } from "./session-store.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

// SPEC §3.2: RealmError.mfaChallenge() reads the step-up challenge a 412 carries.

test("RealmError.mfaChallenge reads the token and methods from details", () => {
  const e = new RealmError({
    code: "mfa_registration_required", httpStatus: 412, message: "m",
    details: { mfa_challenge_token: "enroll-tok-1", methods: ["totp", 7, "otp"] },
  });
  assert.deepEqual(e.mfaChallenge(), { mfaChallengeToken: "enroll-tok-1", methods: ["totp", "otp"] });
});

test("RealmError.mfaChallenge yields empty values when absent or mistyped", () => {
  const none = new RealmError({ code: "mfa_required", httpStatus: 412, message: "m" });
  assert.deepEqual(none.mfaChallenge(), { mfaChallengeToken: "", methods: [] });
  const bad = new RealmError({ code: "mfa_required", message: "m", details: { mfa_challenge_token: 5, methods: "totp" } });
  assert.deepEqual(bad.mfaChallenge(), { mfaChallengeToken: "", methods: [] });
});

test("mintMfaChallenge: a 412 mfa_registration_required error carries the token via mfaChallenge()", async () => {
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (isPlatformMint(url, init)) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok-platform", access_token: "pt_x", expires_in: 300 }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    assert.match(url, /\/auth\/mfa\/challenge$/);
    return new Response(JSON.stringify({ error: {
      code: "mfa_registration_required", message: "mfa registration required",
      mfa_challenge_token: "enroll-tok-1", tenant_id: "t1", methods: ["totp"],
    } }), { status: 412, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch } as never);
  try {
    await realm.withUserToken("user-jwt").auth.mintMfaChallenge();
    assert.fail("expected a 412");
  } catch (e) {
    assert.ok(e instanceof RealmError);
    assert.equal(e.code, "mfa_registration_required");
    assert.deepEqual(e.mfaChallenge(), { mfaChallengeToken: "enroll-tok-1", methods: ["totp"] });
  }
});
