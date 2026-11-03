import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Verifier } from "./verifier.js";
import { createRealm } from "./realm.js";
import { createMemorySessionStore } from "./session-store.js";
import { createSplitRealm } from "./split.js";
import { RealmError } from "./errors.js";
import {
  SplitKey, FakeIssuer, MemShares, jsonReply, userClaims, TEST_REALM, BASE,
} from "./split-testutil.test.js";

// SPEC §1 / §5 / §14.4: issuerUrl is the host the issuer stamps into `iss`
// (default baseUrl). Only the iss checks read it; every fetch stays on baseUrl.
// Mirrors go/issuer_url_test.go.

const INTERNAL = "http://internal.test:8080";
const PUBLIC = "https://public.example";
const REALM_ID = "01HXYZREALM";
const AUD = "example.com";
const NOW = new Date("2026-04-01T00:00:00Z");

async function mintKey(kid: string) {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  const publicJwk = { kty: jwk.kty!, n: jwk.n!, e: jwk.e!, kid, alg: "RS256", use: "sig" };
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = async (claims: Record<string, unknown>): Promise<string> => {
    const input = `${enc({ alg: "RS256", typ: "JWT", kid })}.${enc(claims)}`;
    const sig = await globalThis.crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { publicJwk, sign };
}

/** A fetch standing for the INTERNAL server: serves JWKS and records every URL (positive control). */
function internalFetch(publicJwk: object) {
  const urls: string[] = [];
  const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url === `${INTERNAL}/${REALM_ID}/.well-known/jwks.json`) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch, urls };
}

const claimsFor = (iss: string) => ({ iss, sub: "u", aud: AUD, exp: Math.floor(NOW.getTime() / 1000) + 900 });

function verifierFor(fetch: typeof globalThis.fetch, issuerUrl?: string) {
  return new Verifier({ baseUrl: INTERNAL, issuerUrl, realmId: REALM_ID, audience: AUD, fetch, now: () => NOW });
}

const wrongIssuer = (e: unknown) => e instanceof RealmError && e.code === "wrong_issuer";

test("issuerUrl: verifies against the public issuer while fetching from the internal baseUrl", async () => {
  const { publicJwk, sign } = await mintKey("kid-1");
  const { fetch, urls } = internalFetch(publicJwk);
  const v = verifierFor(fetch, PUBLIC);
  const claims = await v.verify(await sign(claimsFor(`${PUBLIC}/${REALM_ID}`)));
  assert.equal(claims.sub, "u");
  assert.deepEqual(urls, [`${INTERNAL}/${REALM_ID}/.well-known/jwks.json`], "JWKS must be fetched once, from baseUrl");
});

test("issuerUrl: unset still checks baseUrl", async () => {
  const { publicJwk, sign } = await mintKey("kid-1");
  const { fetch } = internalFetch(publicJwk);
  const v = verifierFor(fetch, undefined);
  await assert.rejects(async () => v.verify(await sign(claimsFor(`${PUBLIC}/${REALM_ID}`))), wrongIssuer);
  assert.equal((await v.verify(await sign(claimsFor(`${INTERNAL}/${REALM_ID}`)))).sub, "u", "control: baseUrl iss passes");
});

test("issuerUrl: trailing slash trimmed", async () => {
  const { publicJwk, sign } = await mintKey("kid-1");
  const { fetch } = internalFetch(publicJwk);
  const v = verifierFor(fetch, `${PUBLIC}/`);
  assert.equal((await v.verify(await sign(claimsFor(`${PUBLIC}/${REALM_ID}`)))).sub, "u");
});

test("issuerUrl: blank or whitespace falls back to baseUrl", async () => {
  for (const blank of ["", "   ", "\t\n"]) {
    const { publicJwk, sign } = await mintKey("kid-1");
    const { fetch } = internalFetch(publicJwk);
    const v = verifierFor(fetch, blank);
    assert.equal((await v.verify(await sign(claimsFor(`${INTERNAL}/${REALM_ID}`)))).sub, "u", `blank ${JSON.stringify(blank)}`);
    await assert.rejects(async () => v.verify(await sign(claimsFor(`${PUBLIC}/${REALM_ID}`))), wrongIssuer, `blank ${JSON.stringify(blank)}`);
  }
});

test("issuerUrl: wrong_issuer names the received iss only", async () => {
  const { publicJwk, sign } = await mintKey("kid-1");
  const { fetch } = internalFetch(publicJwk);
  const v = verifierFor(fetch, PUBLIC);
  await assert.rejects(async () => v.verify(await sign(claimsFor(`https://evil.example/${REALM_ID}`))), (e: unknown) => {
    assert.ok(wrongIssuer(e), String(e));
    const msg = (e as Error).message;
    assert.ok(msg.includes(`https://evil.example/${REALM_ID}`), msg);
    assert.ok(!msg.includes(PUBLIC), `message leaks the expected issuer: ${msg}`);
    return true;
  });
});

test("issuerUrl: an iss naming another realm is refused, before any JWKS fetch", async () => {
  const { publicJwk, sign } = await mintKey("kid-1");
  const { fetch, urls } = internalFetch(publicJwk);
  const v = verifierFor(fetch, PUBLIC);
  await assert.rejects(async () => v.verify(await sign(claimsFor(`${PUBLIC}/01HOTHERREALM`))), wrongIssuer);
  await assert.rejects(async () => v.verify(await sign(claimsFor(`${PUBLIC}/${REALM_ID}X`))), wrongIssuer, "bare prefix must not accept <realmId>X");
  assert.deepEqual(urls, [], "a refused iss must not trigger a JWKS fetch");
});

test("issuerUrl: a realm built with issuerUrl wires it into verify (createRealm)", async () => {
  const { publicJwk, sign } = await mintKey("kid-1");
  const { fetch, urls } = internalFetch(publicJwk);
  const realm = createRealm({
    sessionStore: createMemorySessionStore(), realmId: REALM_ID, apiKey: "rk", baseUrl: INTERNAL,
    issuerUrl: PUBLIC, audience: AUD, fetch, clock: () => NOW,
  });
  assert.equal((await realm.verify(await sign(claimsFor(`${PUBLIC}/${REALM_ID}`)))).sub, "u");
  assert.equal(urls.length, 1);
  await assert.rejects(async () => realm.verify(await sign(claimsFor(`${PUBLIC}/01HOTHERREALM`))), wrongIssuer);
});

test("issuerUrl: the co-signer's expected iss is issuerUrl + / + realmId", async () => {
  const k = await SplitKey.make("split-1");
  const mk = (iss: string) => {
    const f = new FakeIssuer();
    f.on("/auth/token/partial", async () => jsonReply(200, await k.partialAnswer(userClaims(iss), "rt2")));
    const cfg = f.cfg((c) => { c.issuerUrl = `${PUBLIC}/`; });
    return createSplitRealm({ ...cfg, shareSource: new MemShares(k.bundle(TEST_REALM)) });
  };
  // control: the public iss is accepted by the co-signer
  const out = await mk(`${PUBLIC}/${TEST_REALM}`).auth.token({ refreshToken: "rt", tenantId: "t1" });
  assert.equal(out.accessToken.split(".").length, 3);
  // the baseUrl iss is no longer the expected one
  await assert.rejects(mk(`${BASE}/${TEST_REALM}`).auth.token({ refreshToken: "rt", tenantId: "t1" }), /foreign issuer/);
});
