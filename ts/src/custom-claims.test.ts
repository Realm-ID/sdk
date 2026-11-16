import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemorySessionStore } from "./session-store.js";
import { createRealm } from "./realm.js";
import { createVerifier } from "./verifier.js";
import { RealmError, RefreshHandedOverError } from "./errors.js";
import { isPlatformMint } from "./auth-mint-helpers.test.js";
import {
  CustomClaimKeyError, CustomClaimsError, RESERVED_CLAIMS, checkClaimKey, checkPayloadKeys,
  type CustomClaimsHandler,
} from "./custom-claims.js";

// custom-claims.test.ts — owner ruling 2026-11-14, audit e-01 / e-02.
// Spec: sdk/SPEC.md SPEC10_1_4_no_client_claims (§10.1 step 4), SPEC10_2_custom_claims
// (§10.2 handler), SPEC4_2_claim_fold (§4.2 rules 1-2), vectors in
// testdata/claim-fold-vectors/.

interface Vectors {
  reserved: string[];
  key_case_count: number;
  payload_case_count: number;
  keys: { id: string; key: string; expect: "accept" | "refuse_reserved" | "refuse_charset" }[];
  payloads: { id: string; payload_json: string; expect: "accept" | "refuse" }[];
}
const vectors = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../testdata/claim-fold-vectors/vectors.json", import.meta.url)), "utf8")) as Vectors;

test("claim-fold vectors: reserved set equals the file's, every case runs and passes", () => {
  assert.deepEqual([...RESERVED_CLAIMS].sort(), [...vectors.reserved].sort(), "reserved-set drift");
  assert.ok(vectors.keys.length > 0 && vectors.payloads.length > 0, "zero cases");
  assert.equal(vectors.keys.length, vectors.key_case_count);
  assert.equal(vectors.payloads.length, vectors.payload_case_count);
  let failed = 0;
  for (const k of vectors.keys) {
    if (checkClaimKey(k.key) !== k.expect) { failed++; console.error("key case failed", k.id); }
  }
  for (const p of vectors.payloads) {
    const got = checkPayloadKeys(p.payload_json) === undefined ? "accept" : "refuse";
    if (got !== p.expect) { failed++; console.error("payload case failed", p.id); }
  }
  console.log(`claim-fold-vectors ts: ran ${vectors.keys.length} key + ${vectors.payloads.length} payload cases, ${failed} failed`);
  assert.equal(failed, 0);
});

// --- verify() wiring: a SIGNED token per refusal reason ---------------------

function b64u(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString("base64url");
}

async function signedVerifier() {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", kp.publicKey);
  const fetchFn = (async () => new Response(JSON.stringify({ keys: [{ kty: jwk.kty, n: jwk.n, e: jwk.e, kid: "k1", alg: "RS256", use: "sig" }] }),
    { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  const now = new Date("2026-04-01T00:00:00Z");
  const v = createVerifier({ realmId: "R", baseUrl: "https://auth.test", audience: "a", fetch: fetchFn, now: () => now });
  const iat = Math.floor(now.getTime() / 1000);
  const sign = async (payloadJson: string) => {
    const input = `${b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }))}.${b64u(payloadJson)}`;
    const sig = await globalThis.crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64u(new Uint8Array(sig))}`;
  };
  const base = `"iss":"https://auth.test/R","sub":"u1","aud":"a","exp":${iat + 900},"iat":${iat}`;
  return { v, sign, base };
}

for (const [name, extra] of [
  ["reserved fold collision", `,"Sub":"victim"`],
  ["non-ASCII key", `,"\\u017fub":"victim"`],
  ["duplicate key", `,"sub":"u2"`],
] as const) {
  test(`verify: a signed token with a ${name} is malformed`, async () => {
    const { v, sign, base } = await signedVerifier();
    await assert.rejects(v.verify(await sign(`{${base}${extra}}`)), (e: unknown) => e instanceof RealmError && e.code === "malformed");
  });
}

test("verify: a clean signed token still verifies (positive control)", async () => {
  const { v, sign, base } = await signedVerifier();
  const c = await v.verify(await sign(`{${base},"outlets":["o1"]}`));
  assert.equal(c.sub, "u1");
});

// --- middleware + handler ---------------------------------------------------

class MockRes {
  statusCode = 200;
  headers: Record<string, string | string[] | number> = {};
  chunks: string[] = [];
  headersSent = false;
  setHeader(n: string, v: string | string[] | number) { this.headers[n.toLowerCase()] = v; }
  getHeader(n: string) { return this.headers[n.toLowerCase()]; }
  writeHead(s: number) { this.statusCode = s; }
  end(c?: string) { if (c) this.chunks.push(c); this.headersSent = true; }
  get body() { return this.chunks.join(""); }
}

function fakeJwt(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", kid: "k" })}.${b64({ sub, exp: 4102444800 })}.sig`;
}

function rig(customClaims?: CustomClaimsHandler) {
  const mints: Record<string, unknown>[] = [];
  const realm = createRealm({
    sessionStore: createMemorySessionStore(), realmId: "r1", apiKey: "rk_live_x",
    baseUrl: "https://auth.test", origin: "https://app.test",
    customClaims,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (isPlatformMint(url, init)) {
        return new Response(JSON.stringify({ status: "ok", subject_type: "platform", refresh_token: "rp", access_token: "pt_x", expires_in: 300 }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/auth/token")) {
        mints.push(body);
        return new Response(JSON.stringify({ access_token: fakeJwt("u-refresh"), refresh_token: `rtok${mints.length + 1}`,
          expires_in: 900, subject_type: "user", tenant_id: "t1", role: "member" }),
          { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected url " + url);
    }) as typeof fetch,
  });
  return {
    mints, realm,
    async refresh(body: Record<string, unknown>) {
      const res = new MockRes();
      await realm.middleware({})({ url: "/token", method: "POST", headers: { cookie: "realmid_refresh=rtok" }, body } as never,
        res as never, ((e?: unknown) => { throw new Error("fell through " + String(e)); }) as never);
      return res;
    },
  };
}

for (const [label, body] of [
  ["custom_claims object", { tenant_id: "t1", custom_claims: { outlet_ids: ["x"] } }],
  ["customClaims object", { tenant_id: "t1", customClaims: { outlet_ids: ["x"] } }],
  ["custom_claims null", { tenant_id: "t1", custom_claims: null }],
  ["custom_claims empty object", { tenant_id: "t1", custom_claims: {} }],
  ["custom_claims non-object", { tenant_id: "t1", custom_claims: 7 }],
] as const) {
  test(`refresh route: ${label} is refused 400 custom_claims_not_accepted and nothing is minted`, async () => {
    const r = rig(() => ({ a: 1 }));
    const res = await r.refresh({ ...body });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error.code, "custom_claims_not_accepted");
    assert.equal(r.mints.length, 0, "the issuer must not be called (refresh token not consumed)");
  });
}

test("refresh route: the handler's claims, called with (tenant, sub), ride the FINAL mint", async () => {
  let saw: [string, string] | undefined;
  const r = rig((t, u) => { saw = [t, u]; return { outlet_ids: ["o1"] }; });
  const res = await r.refresh({ tenant_id: "t1" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(saw, ["t1", "u-refresh"]);
  assert.deepEqual(r.mints[r.mints.length - 1]!["custom_claims"], { outlet_ids: ["o1"] });
});

test("refresh route: no handler -> no custom_claims on any mint", async () => {
  const r = rig();
  const res = await r.refresh({ tenant_id: "t1" });
  assert.equal(res.statusCode, 200);
  for (const m of r.mints) assert.equal(m["custom_claims"], undefined);
});

test("handler: an error is retried 3 times, then the refresh is refused (no under-granting)", async () => {
  let calls = 0;
  const r = rig(() => { calls++; throw new Error("db down"); });
  const res = await r.refresh({ tenant_id: "t1" });
  assert.equal(calls, 3);
  assert.notEqual(res.statusCode, 200);
});

test("handler: a reserved or non-ASCII key refuses the mint with an error naming the key", async () => {
  for (const bad of ["Sub", "région", "acr"]) {
    const r = rig(() => ({ [bad]: "x" }));
    await assert.rejects(
      r.realm.auth.enrichRefresh({ accessToken: fakeJwt("u1"), refreshToken: "rt", expiresIn: 1, tenantId: "t1" }, "t1"),
      // SPEC4_2_rotate_handover: after the first mint rotated the token, the key error rides the carrier as its cause.
      (e: unknown) => e instanceof RefreshHandedOverError && e.cause instanceof CustomClaimKeyError && e.cause.key === bad,
    );
    assert.equal(r.mints.length, 0, "a refused key must never reach the issuer");
  }
});

test("direct auth.token(): explicit customClaims are sent as given; omitted + handler -> filled", async () => {
  const r = rig(() => ({ from: "handler" }));
  await r.realm.auth.token({ refreshToken: "rt", tenantId: "t1", customClaims: { mine: 1 } });
  assert.deepEqual(r.mints[0]!["custom_claims"], { mine: 1 });
  r.mints.length = 0;
  await r.realm.auth.token({ refreshToken: "rt2", tenantId: "t1" });
  assert.deepEqual(r.mints[r.mints.length - 1]!["custom_claims"], { from: "handler" });
});

test("login lane: the handler's claims ride the login mint", async () => {
  const { AuthClient } = await import("./auth.js");
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const http = {
    async request<T>(o: { path: string; body?: unknown }): Promise<T> {
      calls.push({ path: o.path, body: (o.body ?? {}) as Record<string, unknown> });
      if (o.path === "/auth/login") {
        return { access_token: fakeJwt("u1"), refresh_token: "rt", expires_in: 900, user: { id: "u1" }, tenants: [{ tenant_id: "t1", id: "t1", role: "owner" }] } as T;
      }
      return { access_token: fakeJwt("u1"), refresh_token: "rt2", expires_in: 900, subject_type: "user", tenant_id: "t1", role: "owner" } as T;
    },
  } as never;
  const c = new AuthClient(http, "r1", async () => undefined, undefined, undefined, undefined, undefined, undefined,
    () => ({ outlet_ids: ["o9"] }));
  await c.login({ method: "firebase", providerToken: "pt" });
  const mint = calls.find((x) => x.path === "/auth/token");
  assert.ok(mint, "customClaims-only consumer must still mint on login");
  assert.deepEqual(mint.body["custom_claims"], { outlet_ids: ["o9"] });
});
