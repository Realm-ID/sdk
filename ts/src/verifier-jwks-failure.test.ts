import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Verifier } from "./verifier.js";
import { RealmError } from "./errors.js";

// SPEC §2 — any failure to fetch or parse the JWKS is `jwks_fetch_failed`, and it is the
// recorded attempt for the 5 second window. One bad key fails the whole set.

const BASE_URL = "https://auth.test.example";
const REALM_ID = "01HXYZREALM";
const AUD = "example.com";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function mintKey(kid: string) {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  const publicJwk = { kty: jwk.kty!, n: jwk.n!, e: jwk.e!, kid, alg: "RS256", use: "sig" };
  const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  async function sign(claims: Record<string, unknown>): Promise<string> {
    const input = `${enc({ alg: "RS256", typ: "JWT", kid })}.${enc(claims)}`;
    const sig = await globalThis.crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  }
  return { publicJwk, sign };
}

const isFetchFailed = (e: unknown) => e instanceof RealmError && e.code === "jwks_fetch_failed";

const BAD_BODIES: Record<string, (good: object) => string> = {
  "a body that is not JSON": () => "<html>not json</html>",
  "a key with no modulus": (good) =>
    JSON.stringify({ keys: [good, { kty: "RSA", kid: "kid-bad", e: "AQAB" }] }),
  "a key with no exponent": (good) =>
    JSON.stringify({ keys: [good, { kty: "RSA", kid: "kid-bad", n: "AQAB" }] }),
};

for (const [name, body] of Object.entries(BAD_BODIES)) {
  test(`verify: ${name} is jwks_fetch_failed and is the recorded attempt`, async () => {
    const known = await mintKey("kid-known");
    const other = await mintKey("kid-other");
    const state = { bad: false, count: 0 };
    const fetch = (async (): Promise<Response> => {
      state.count++;
      const text = state.bad ? body(known.publicJwk) : JSON.stringify({ keys: [known.publicJwk] });
      return new Response(text, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const clock = { t: new Date("2026-04-01T00:00:00Z").getTime() };
    const v = new Verifier({ realmId: REALM_ID, baseUrl: BASE_URL, audience: AUD, fetch, now: () => new Date(clock.t) });
    const claims = () => {
      const iat = Math.floor(clock.t / 1000);
      return { iss: `${BASE_URL}/${REALM_ID}`, sub: "u1", aud: AUD, iat, exp: iat + 900 };
    };
    await v.verify(await known.sign(claims()));
    state.bad = true;
    clock.t += 5_000;
    const stranger = await other.sign(claims());
    await assert.rejects(v.verify(stranger), isFetchFailed);
    assert.equal(state.count, 2);
    await assert.rejects(v.verify(stranger), isFetchFailed);
    assert.equal(state.count, 2, "the failed attempt starts the window");
  });
}

test("verify: a 200 with an empty keys array is unknown_kid", async () => {
  const other = await mintKey("kid-other");
  const fetch = (async () => new Response(JSON.stringify({ keys: [] }), { status: 200 })) as typeof fetch;
  const v = new Verifier({ realmId: REALM_ID, baseUrl: BASE_URL, audience: AUD, fetch });
  const iat = Math.floor(Date.now() / 1000);
  const tok = await other.sign({ iss: `${BASE_URL}/${REALM_ID}`, sub: "u1", aud: AUD, iat, exp: iat + 900 });
  await assert.rejects(v.verify(tok), (e: unknown) => e instanceof RealmError && e.code === "unknown_kid");
});
