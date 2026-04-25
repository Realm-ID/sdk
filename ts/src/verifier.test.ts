import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Verifier } from "./verifier.js";
import { RealmError } from "./errors.js";

const BASE_URL = "https://auth.test.example";
const REALM_ID = "01HXYZREALM";
const AUD = "example.com";

/** Generate RSA keypair, export JWK for public, return signer fn + jwk. */
async function mintKey(kid: string) {
  const kp = await globalThis.crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  const publicJwk = { kty: jwk.kty!, n: jwk.n!, e: jwk.e!, kid, alg: "RS256", use: "sig" };
  async function signToken(claims: Record<string, unknown>): Promise<string> {
    const header = { alg: "RS256", typ: "JWT", kid };
    const enc = (obj: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
    const signingInput = `${enc(header)}.${enc(claims)}`;
    const sig = await globalThis.crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      kp.privateKey,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
  }
  return { publicJwk, signToken };
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fakeFetch(realmKeys: Record<string, object[]>): {
  fetch: typeof fetch;
  calls: { count: number };
} {
  const calls = { count: 0 };
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.count++;
    const url = typeof input === "string" ? input : input.toString();
    for (const realm of Object.keys(realmKeys)) {
      if (url.endsWith(`/${realm}/.well-known/jwks.json`)) {
        return new Response(JSON.stringify({ keys: realmKeys[realm] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch, calls };
}

test("verify: happy path", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const { fetch, calls } = fakeFetch({ [REALM_ID]: [publicJwk] });

  const now = new Date("2026-04-01T00:00:00Z");
  const v = new Verifier({ baseUrl: BASE_URL, audience: AUD, fetch, now: () => now });

  const exp = Math.floor(now.getTime() / 1000) + 900;
  const token = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`,
    sub: "user-1",
    aud: AUD,
    exp,
    iat: Math.floor(now.getTime() / 1000),
    tenant_id: "tenant-1",
    role: "owner",
  });

  const claims = await v.verify(token);
  assert.equal(claims.sub, "user-1");
  assert.equal(claims.tenant_id, "tenant-1");
  assert.equal(calls.count, 1);

  await v.verify(token);
  assert.equal(calls.count, 1);
});

test("verify: wrong audience rejected", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const { fetch } = fakeFetch({ [REALM_ID]: [publicJwk] });
  const now = new Date("2026-04-01T00:00:00Z");
  const v = new Verifier({ baseUrl: BASE_URL, audience: AUD, fetch, now: () => now });

  const token = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`,
    sub: "u",
    aud: "wrong.example",
    exp: Math.floor(now.getTime() / 1000) + 900,
  });
  await assert.rejects(() => v.verify(token), (e: Error) => {
    return e instanceof RealmError && e.code === "wrong_audience";
  });
});

test("verify: wrong issuer rejected", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const { fetch } = fakeFetch({ [REALM_ID]: [publicJwk] });
  const now = new Date("2026-04-01T00:00:00Z");
  const v = new Verifier({ baseUrl: BASE_URL, audience: AUD, fetch, now: () => now });

  const token = await signToken({
    iss: `https://evil.example/${REALM_ID}`,
    sub: "u",
    aud: AUD,
    exp: Math.floor(now.getTime() / 1000) + 900,
  });
  await assert.rejects(() => v.verify(token), (e: Error) => {
    return e instanceof RealmError && e.code === "wrong_issuer";
  });
});

test("verify: expired rejected", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const { fetch } = fakeFetch({ [REALM_ID]: [publicJwk] });
  const now = new Date("2026-04-01T00:00:00Z");
  const v = new Verifier({ baseUrl: BASE_URL, audience: AUD, fetch, now: () => now, leewaySeconds: 0 });

  const token = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`,
    sub: "u",
    aud: AUD,
    exp: Math.floor(now.getTime() / 1000) - 1,
  });
  await assert.rejects(() => v.verify(token), (e: Error) => {
    return e instanceof RealmError && e.code === "expired";
  });
});

test("verify: tampered signature rejected", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const { fetch } = fakeFetch({ [REALM_ID]: [publicJwk] });
  const now = new Date("2026-04-01T00:00:00Z");
  const v = new Verifier({ baseUrl: BASE_URL, audience: AUD, fetch, now: () => now });

  const good = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`,
    sub: "u",
    aud: AUD,
    exp: Math.floor(now.getTime() / 1000) + 900,
  });
  const parts = good.split(".");
  parts[2] = parts[2]!.slice(0, -1) + (parts[2]!.slice(-1) === "A" ? "B" : "A");
  const bad = parts.join(".");

  await assert.rejects(() => v.verify(bad), (e: Error) => {
    return e instanceof RealmError && e.code === "bad_signature";
  });
});

test("verify: unknown kid triggers refetch", async () => {
  const a = await mintKey("kid-old");
  const b = await mintKey("kid-new");

  let call = 0;
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    call++;
    const url = typeof input === "string" ? input : input.toString();
    if (!url.endsWith(`/${REALM_ID}/.well-known/jwks.json`)) {
      return new Response("not found", { status: 404 });
    }
    const keys = call === 1 ? [a.publicJwk] : [a.publicJwk, b.publicJwk];
    return new Response(JSON.stringify({ keys }), { status: 200 });
  }) as typeof fetch;

  const now = new Date("2026-04-01T00:00:00Z");
  const v = new Verifier({ baseUrl: BASE_URL, audience: AUD, fetch, now: () => now });

  const tokOld = await a.signToken({
    iss: `${BASE_URL}/${REALM_ID}`, sub: "u", aud: AUD,
    exp: Math.floor(now.getTime() / 1000) + 900,
  });
  await v.verify(tokOld);
  assert.equal(call, 1);

  const tokNew = await b.signToken({
    iss: `${BASE_URL}/${REALM_ID}`, sub: "u", aud: AUD,
    exp: Math.floor(now.getTime() / 1000) + 900,
  });
  await v.verify(tokNew);
  assert.equal(call, 2);
});

test("constructor: missing config rejected", () => {
  assert.throws(() => new Verifier({ baseUrl: "", audience: "x" }));
  assert.throws(() => new Verifier({ baseUrl: "http://x" }));
});

test("verify: malformed token rejected", async () => {
  const now = new Date("2026-04-01T00:00:00Z");
  const v = new Verifier({ baseUrl: BASE_URL, audience: AUD, fetch: fakeFetch({}).fetch, now: () => now });

  await assert.rejects(() => v.verify("not.a"), (e: Error) => {
    return e instanceof RealmError && e.code === "malformed";
  });
});

test("verify: audience auto-discovered via resolver and cached", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const { fetch } = fakeFetch({ [REALM_ID]: [publicJwk] });
  const now = new Date("2026-04-01T00:00:00Z");
  let resolveCalls = 0;
  const v = new Verifier({
    baseUrl: BASE_URL,
    audienceResolver: async (rid) => {
      resolveCalls++;
      assert.equal(rid, REALM_ID);
      return AUD;
    },
    fetch,
    now: () => now,
  });

  const token = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`, sub: "u", aud: AUD,
    exp: Math.floor(now.getTime() / 1000) + 900,
  });
  await v.verify(token);
  await v.verify(token);
  assert.equal(resolveCalls, 1, "resolver should be cached");
});

test("verify: per-call audience override wins over resolver", async () => {
  const { publicJwk, signToken } = await mintKey("kid-1");
  const { fetch } = fakeFetch({ [REALM_ID]: [publicJwk] });
  const now = new Date("2026-04-01T00:00:00Z");
  const v = new Verifier({
    baseUrl: BASE_URL,
    audienceResolver: async () => "would-be-wrong.example",
    fetch,
    now: () => now,
  });

  const token = await signToken({
    iss: `${BASE_URL}/${REALM_ID}`, sub: "u", aud: AUD,
    exp: Math.floor(now.getTime() / 1000) + 900,
  });
  const claims = await v.verify(token, { audience: AUD });
  assert.equal(claims.sub, "u");
});
