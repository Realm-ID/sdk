// SPEC §X.4a (issuer ADR-123): auth.sendLoginCode accepts deliveryMode "email" (an email address as the
// identifier) and sends it as `delivery_mode: "email"`. The type check is part of the test: `tsc` fails
// if "email" is not in the deliveryMode union.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { RealmError } from "./errors.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";

function setup(status: number, body: unknown): { realm: ReturnType<typeof createRealm>; sent: unknown[] } {
  const sent: unknown[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (isPlatformMint(url, init)) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok", access_token: "pt_x", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    sent.push(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { realm: createRealm({ sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch }), sent };
}

test("sendLoginCode with deliveryMode email sends delivery_mode email and the address", async () => {
  const { realm, sent } = setup(202, { sent_if_registered: true });
  const out = await realm.auth.sendLoginCode({ identifier: "ana@acme.example", deliveryMode: "email", onBehalfOfIp: "203.0.113.9" });
  assert.deepEqual(out, { sentIfRegistered: true });
  assert.deepEqual(sent[0], { identifier: "ana@acme.example", delivery_mode: "email" });
});

test("email_otp_rate_limited (429) reaches the caller as its own code with the Retry-After wait", async () => {
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (isPlatformMint(url, init)) {
      return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rtok", access_token: "pt_x", expires_in: 300 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { code: "email_otp_rate_limited", message: "m" } }),
      { status: 429, headers: { "content-type": "application/json", "retry-after": "120" } });
  }) as typeof fetch;
  const realm = createRealm({ sessionStore: createMemorySessionStore(), realmId: "r", apiKey: "rk_live_x", baseUrl: "https://auth.test", fetch });
  await assert.rejects(() => realm.auth.sendLoginCode({ identifier: "a@b.example", deliveryMode: "email" }), (e: Error) =>
    e instanceof RealmError && (e.code as string) === "email_otp_rate_limited" && e.retryAfterSeconds === 120);
});
