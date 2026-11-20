import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Verifier } from "./verifier.js";
import { RealmError } from "./errors.js";

// SPEC §2 — JWKS response shape: any 2xx is parsed, a key without a kid is ignored, a key with a
// kid but unusable RSA material fails the whole set as `jwks_fetch_failed`.

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

async function verifyWith(status: number, mk: (good: object) => string): Promise<void> {
  const known = await mintKey("kid-known");
  const fetch = (async () => new Response(mk(known.publicJwk), { status })) as typeof fetch;
  const v = new Verifier({ realmId: REALM_ID, baseUrl: BASE_URL, audience: AUD, fetch });
  const iat = Math.floor(Date.now() / 1000);
  await v.verify(await known.sign({ iss: `${BASE_URL}/${REALM_ID}`, sub: "u1", aud: AUD, iat, exp: iat + 900 }));
}

const code = (c: string) => (e: unknown) => e instanceof RealmError && e.code === c;
const withExtra = (...extra: object[]) => (good: object) => JSON.stringify({ keys: [good, ...extra] });

test("jwks shape: any 2xx is parsed", async () => {
  for (const status of [200, 201, 203]) await verifyWith(status, withExtra());
});

test("jwks shape: a non-2xx status is jwks_fetch_failed", async () => {
  for (const status of [404, 500]) await assert.rejects(verifyWith(status, withExtra()), code("jwks_fetch_failed"));
});

const KEYLESS: Record<string, object> = {
  "unusable material": { kty: "RSA", n: "@@@", e: "AQAB" },
  "empty material": { kty: "RSA" },
  "usable material": { kty: "RSA", n: "AQAB", e: "AQAB" },
};
for (const [name, k] of Object.entries(KEYLESS)) {
  test(`jwks shape: a key without a kid is ignored (${name})`, async () => {
    await verifyWith(200, withExtra(k));
  });
}

const UNUSABLE: Record<string, object> = {
  "n missing": { kty: "RSA", kid: "kid-bad", e: "AQAB" },
  "e missing": { kty: "RSA", kid: "kid-bad", n: "AQAB" },
  "n empty": { kty: "RSA", kid: "kid-bad", n: "", e: "AQAB" },
  "e empty": { kty: "RSA", kid: "kid-bad", n: "AQAB", e: "" },
  "n undecodable": { kty: "RSA", kid: "kid-bad", n: "@@@", e: "AQAB" },
  "e undecodable": { kty: "RSA", kid: "kid-bad", n: "AQAB", e: "@@@" },
  "n padded": { kty: "RSA", kid: "kid-bad", n: "AQAB=", e: "AQAB" },
  "e padded": { kty: "RSA", kid: "kid-bad", n: "AQAB", e: "AQAB=" },
};
for (const [name, k] of Object.entries(UNUSABLE)) {
  test(`jwks shape: a key with a kid and unusable material fails the set (${name})`, async () => {
    await assert.rejects(verifyWith(200, withExtra(k)), code("jwks_fetch_failed"));
  });
}

test("jwks shape: padding on n or e fails the set even when the unpadded form is valid", async () => {
  await assert.rejects(verifyWith(200, (good) => JSON.stringify({ keys: [good, { ...good, kid: "kid-bad", n: (good as { n: string }).n + "==" }] })), code("jwks_fetch_failed"));
  await assert.rejects(verifyWith(200, withExtra({ kty: "RSA", kid: "kid-bad", n: "AQAB", e: "AQABAQ==" })), code("jwks_fetch_failed"));
});

for (const kid of [123, true, { a: 1 }, ["x"], null]) {
  test(`jwks shape: a non-string kid is skipped (${JSON.stringify(kid)})`, async () => {
    await verifyWith(200, withExtra({ kty: "RSA", kid, n: "AQAB", e: "AQAB" }));
  });
}

test("jwks shape: a top-level value that is not an object is jwks_fetch_failed", async () => {
  for (const body of ["", "[]", '"x"', "5"]) {
    await assert.rejects(verifyWith(200, () => body), code("jwks_fetch_failed"));
  }
});

test("jwks shape: absent or null keys is unknown_kid", async () => {
  for (const body of ["{}", '{"keys":null}', '{"keys":[]}']) {
    await assert.rejects(verifyWith(200, () => body), code("unknown_kid"));
  }
});
