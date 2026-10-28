// SPEC §3: RealmError.retryAfterSeconds carries the server's Retry-After on any
// non-2xx response (delta-seconds or HTTP-date); undefined = absent/unparseable.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

async function failWith(status: number, retryAfter: string | undefined): Promise<RealmError> {
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (isPlatformMint(url, init)) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok", access_token: "pt_x", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
    return new Response(JSON.stringify({ error: "slow down", code: "phone_otp_rate_limited" }), { status, headers });
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  try {
    await realm.auth.sendLoginCode({ identifier: "+919999000011", deliveryMode: "sms" });
  } catch (e) {
    assert.ok(e instanceof RealmError);
    return e;
  }
  throw new Error("expected a RealmError");
}

test("SPEC3 retryAfterSeconds: 429 with Retry-After: 120 -> 120", async () => {
  const e = await failWith(429, "120");
  assert.equal(e.httpStatus, 429);
  assert.equal(e.retryAfterSeconds, 120);
});

test("SPEC3 retryAfterSeconds: present on a 503 too", async () => {
  assert.equal((await failWith(503, "7")).retryAfterSeconds, 7);
});

test("SPEC3 retryAfterSeconds: absent, garbage, negative, zero -> undefined", async () => {
  for (const v of [undefined, "soon", "-5", "0", "1.5"]) {
    assert.equal((await failWith(429, v)).retryAfterSeconds, undefined, `value ${String(v)}`);
  }
});

test("SPEC3 retryAfterSeconds: HTTP-date is the wait from now, a past date is undefined", async () => {
  const future = new Date(Date.now() + 90_000).toUTCString();
  const got = (await failWith(429, future)).retryAfterSeconds;
  assert.ok(got !== undefined && got >= 80 && got <= 91, `got ${String(got)}`);
  assert.equal((await failWith(429, "Mon, 02 Jan 2006 15:04:05 GMT")).retryAfterSeconds, undefined);
});
