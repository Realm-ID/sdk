import { test } from "node:test";
import { strict as assert } from "node:assert";
import { Verifier } from "./verifier.js";
import { RealmError } from "./errors.js";

const BASE_URL = "https://auth.test.example";
const REALM_ID = "01HXYZREALM";
const AUD = "example.com";

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

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function setup(keys: object[]) {
  const calls = { count: 0 };
  const fetch = (async (): Promise<Response> => {
    calls.count++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ keys }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const clock = { t: new Date("2026-04-01T00:00:00Z").getTime() };
  const v = new Verifier({ realmId: REALM_ID, baseUrl: BASE_URL, audience: AUD, fetch, now: () => new Date(clock.t) });
  const claims = () => {
    const iat = Math.floor(clock.t / 1000);
    return { iss: `${BASE_URL}/${REALM_ID}`, sub: "u1", aud: AUD, iat, exp: iat + 900 };
  };
  return { v, calls, clock, claims };
}

test("verify: an unknown kid refetches the JWKS at most once per 5 seconds", async () => {
  const known = await mintKey("kid-known");
  const other = await mintKey("kid-other");
  const { v, calls, clock, claims } = setup([known.publicJwk]);

  await v.verify(await known.sign(claims()));
  assert.equal(calls.count, 1);

  const stranger = await other.sign(claims());
  for (let i = 0; i < 5; i++) {
    await assert.rejects(v.verify(stranger), (e: unknown) => e instanceof RealmError && e.code === "unknown_kid");
  }
  assert.equal(calls.count, 1, "unknown kid inside the 5s window must not refetch");

  clock.t += 5_000;
  await assert.rejects(v.verify(await other.sign(claims())), (e: unknown) => e instanceof RealmError && e.code === "unknown_kid");
  assert.equal(calls.count, 2, "one refetch once the window has passed");
});

test("verify: concurrent unknown-kid requests share one JWKS fetch", async () => {
  const known = await mintKey("kid-known");
  const other = await mintKey("kid-other");
  const { v, calls, claims } = setup([known.publicJwk]);
  const stranger = await other.sign(claims());
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => v.verify(stranger)));
  assert.equal(results.every((r) => r.status === "rejected"), true);
  assert.equal(calls.count, 1);
});

test("verify: a failed refetch for an unknown kid starts the 5 second window", async () => {
  const known = await mintKey("kid-known");
  const other = await mintKey("kid-other");
  const calls = { count: 0 };
  const fetch = (async (): Promise<Response> => {
    calls.count++;
    await new Promise((r) => setTimeout(r, 20));
    if (calls.count === 1) {
      return new Response(JSON.stringify({ keys: [known.publicJwk] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("boom", { status: 500 });
  }) as typeof fetch;
  const clock = { t: new Date("2026-04-01T00:00:00Z").getTime() };
  const v = new Verifier({ realmId: REALM_ID, baseUrl: BASE_URL, audience: AUD, fetch, now: () => new Date(clock.t) });
  const claims = () => {
    const iat = Math.floor(clock.t / 1000);
    return { iss: `${BASE_URL}/${REALM_ID}`, sub: "u1", aud: AUD, iat, exp: iat + 900 };
  };
  await v.verify(await known.sign(claims()));
  clock.t += 5_000; // the priming fetch started its own window
  const token = await other.sign(claims());
  const run = async () => {
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => v.verify(token)));
    assert.equal(rs.every((r) => r.status === "rejected"), true);
  };
  await run();
  assert.equal(calls.count, 2, "10 unknown-kid verifies against a failing JWKS: one refetch");
  await run();
  assert.equal(calls.count, 2, "still inside the window");
  clock.t += 5_000;
  await run();
  assert.equal(calls.count, 3, "one more fetch after the window");
});

test("verify: a malformed token's error carries httpStatus 401", async () => {
  const { v } = setup([]);
  await assert.rejects(v.verify("not-a-jwt"), (e: unknown) => {
    return e instanceof RealmError && e.code === "malformed" && e.httpStatus === 401;
  });
});

function setupToggle(keys: object[], failing: boolean) {
  const state = { failing, count: 0 };
  const fetch = (async (): Promise<Response> => {
    state.count++;
    if (state.failing) return new Response("boom", { status: 500 });
    return new Response(JSON.stringify({ keys }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const clock = { t: new Date("2026-04-01T00:00:00Z").getTime() };
  const v = new Verifier({ realmId: REALM_ID, baseUrl: BASE_URL, audience: AUD, fetch, now: () => new Date(clock.t) });
  const claims = () => {
    const iat = Math.floor(clock.t / 1000);
    return { iss: `${BASE_URL}/${REALM_ID}`, sub: "u1", aud: AUD, iat, exp: iat + 900 };
  };
  return { v, state, clock, claims };
}

test("verify: the refetch an expired set triggers is not gated by the 5 second window", async () => {
  const known = await mintKey("kid-known");
  const { v, state, clock, claims } = setupToggle([known.publicJwk], false);
  await v.verify(await known.sign(claims()));
  clock.t += 11 * 60_000;
  state.failing = true;
  await assert.rejects(v.verify(await known.sign(claims())), (e: unknown) => e instanceof RealmError && e.code === "jwks_fetch_failed");
  clock.t += 1_000;
  state.failing = false;
  await v.verify(await known.sign(claims()));
  assert.equal(state.count, 3);
});

test("verify: the first-ever fetch is not gated by the window after one failed fetch", async () => {
  const known = await mintKey("kid-known");
  const { v, state, clock, claims } = setupToggle([known.publicJwk], true);
  await assert.rejects(v.verify(await known.sign(claims())), (e: unknown) => e instanceof RealmError && e.code === "jwks_fetch_failed");
  clock.t += 1_000;
  state.failing = false;
  await v.verify(await known.sign(claims()));
  assert.equal(state.count, 2);
});

test("verify: concurrent callers on an expired set share one fetch", async () => {
  const known = await mintKey("kid-known");
  const { v, state, clock, claims } = setupToggle([known.publicJwk], false);
  await v.verify(await known.sign(claims()));
  clock.t += 11 * 60_000;
  const token = await known.sign(claims());
  const rs = await Promise.allSettled(Array.from({ length: 10 }, () => v.verify(token)));
  assert.equal(rs.every((r) => r.status === "fulfilled"), true);
  assert.equal(state.count, 2);
});

for (const [name, hdr] of [["null", "null"], ["array", "[]"], ["string", '"x"'], ["number", "1"]] as const) {
  test(`verify: a token header that is JSON ${name} is malformed with httpStatus 401`, async () => {
    const { v } = setup([]);
    const b = (s: string) => b64url(new TextEncoder().encode(s));
    const pay = JSON.stringify({ iss: `${BASE_URL}/${REALM_ID}`, sub: "u1" });
    await assert.rejects(v.verify(`${b(hdr)}.${b(pay)}.${b("s")}`), (e: unknown) => {
      return e instanceof RealmError && e.code === "malformed" && e.httpStatus === 401;
    });
  });
}

test("verify: a token payload that is JSON null is malformed with httpStatus 401", async () => {
  const { v } = setup([]);
  const b = (s: string) => b64url(new TextEncoder().encode(s));
  const hdr = JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k" });
  await assert.rejects(v.verify(`${b(hdr)}.${b("null")}.${b("s")}`), (e: unknown) => {
    return e instanceof RealmError && e.code === "malformed" && e.httpStatus === 401;
  });
});
