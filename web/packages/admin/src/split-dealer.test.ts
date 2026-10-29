/**
 * SPEC §14.14 / §14.15: the browser dealer. Checks: (1) vector split under lambda, (2) range over
 * >= 20 deals, (3) round trip against a fresh WebCrypto key, (4) shape; plus upload and bundle rules.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { RealmError } from "@realm-id/sdk";
import type { RequestOptions } from "@realm-id/sdk/internal";

import * as entry from "./index.js";
import { dealSplitKey, isSplitKeygenUnsupported } from "./split-dealer.js";
import { splitWithDRi, lambdaOf } from "./split-math.js";
import { SigningKeysClient } from "./signing-keys.js";
import type { HttpLike } from "./transport.js";

const vectors = JSON.parse(readFileSync("../../../testdata/split-vectors/vectors.json", "utf8"));
const hexBig = (s: string): bigint => BigInt("0x" + s);

function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
function b64uToBig(s: string): bigint {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  let h = "";
  for (const ch of bin) h += ch.charCodeAt(0).toString(16).padStart(2, "0");
  return BigInt("0x" + (h || "0"));
}
const SHA256_PREFIX = "3031300d060960864801650304020105000420";
async function emsa(message: BufferSource): Promise<bigint> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", message));
  let h = SHA256_PREFIX + [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  const pad = 256 - h.length / 2 - 3;
  return BigInt("0x0001" + "ff".repeat(pad) + "00" + h);
}

/** A Crypto that hands the generated key pair back to the test. */
function spyCrypto(): { c: Crypto; pair: () => CryptoKeyPair } {
  let pair: CryptoKeyPair | undefined;
  const subtle = {
    generateKey: async (...a: unknown[]) => {
      pair = (await (crypto.subtle.generateKey as (...x: unknown[]) => Promise<CryptoKeyPair>)(...a));
      return pair;
    },
    exportKey: (f: KeyFormat, k: CryptoKey) => crypto.subtle.exportKey(f as "jwk", k),
  };
  return {
    c: { subtle, getRandomValues: (a: never) => crypto.getRandomValues(a) } as unknown as Crypto,
    pair: () => pair!,
  };
}

describe("split math (SPEC 14.14 check 1)", () => {
  it("the dealer vector has d_ri > d and splits to the vector's d_partner under lambda", () => {
    const k = vectors.key;
    assert.ok(vectors.dealer, "vectors.json has a dealer case");
    const d = hexBig(k.d);
    const dRi = hexBig(vectors.dealer.d_ri);
    assert.ok(dRi > d);
    assert.equal(splitWithDRi(hexBig(k.p), hexBig(k.q), d, dRi), hexBig(vectors.dealer.d_partner));
    // and the pair signs: s_ri * s_p == the whole-key signature
    const n = hexBig(k.n);
    const m = hexBig(vectors.jwt_cases[0].m);
    const s = (modPow(m, dRi, n) * modPow(m, hexBig(vectors.dealer.d_partner), n)) % n;
    assert.equal(s, hexBig(vectors.jwt_cases[0].s));
  });

  it("refuses a zero half and an out-of-range d_ri", () => {
    assert.throws(() => splitWithDRi(61n, 53n, 413n, 0n));
    assert.throws(() => splitWithDRi(61n, 53n, 413n, 413n));
    assert.throws(() => splitWithDRi(61n, 53n, 413n, 780n));
    assert.equal(lambdaOf(61n, 53n), 780n);
  });
});

describe("dealSplitKey (SPEC 14.15)", () => {
  it("20 deals: range in [1, lambda), round trip equals the WebCrypto whole-key signature, shape", async () => {
    for (let i = 0; i < 20; i++) {
      const spy = spyCrypto();
      const out = await dealSplitKey({ realm: "realm_x", kid: "k" + i, crypto: spy.c });
      const jwk = await crypto.subtle.exportKey("jwk", spy.pair().privateKey);
      const p = b64uToBig(jwk.p!), q = b64uToBig(jwk.q!), n = b64uToBig(jwk.n!);
      const lam = lambdaOf(p, q);
      const dRi = b64uToBig(out.upload.d_ri);
      const dP = b64uToBig(out.share.shares["k" + i]!.d_partner);
      assert.ok(dRi >= 1n && dRi < lam && dP >= 1n && dP < lam, `deal ${i} range`);

      const msg = new TextEncoder().encode("hello " + i);
      const m = await emsa(msg);
      const s = (modPow(m, dRi, n) * modPow(m, dP, n)) % n;
      const whole = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", spy.pair().privateKey, msg));
      const sBytes = Uint8Array.from(s.toString(16).padStart(512, "0").match(/../g)!.map((h) => parseInt(h, 16)));
      assert.deepEqual(sBytes, whole);
      assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", spy.pair().publicKey, sBytes, msg));

      // shape (check 4): exact keys, no d_ri in the share, no d_partner in the upload
      assert.deepEqual(Object.keys(out.share).sort(), ["realm", "shares"]);
      assert.deepEqual(Object.keys(out.share.shares["k" + i]!).sort(), ["d_partner", "e", "n"]);
      assert.deepEqual(Object.keys(out.upload).sort(), ["d_ri", "e", "kid", "n"]);
      assert.equal(out.upload.n, out.share.shares["k" + i]!.n);
      assert.equal(out.upload.e, "AQAB");
    }
  });

  it("shareJson parses and carries a non-empty d_partner, never d_ri; filename is fixed", async () => {
    const out = await dealSplitKey({ realm: "realm_x", kid: "split-1" });
    const parsed = JSON.parse(out.shareJson);
    assert.equal(parsed.realm, "realm_x");
    assert.ok(typeof parsed.shares["split-1"].d_partner === "string" && parsed.shares["split-1"].d_partner.length > 0);
    assert.ok(!out.shareJson.includes(out.upload.d_ri));
    assert.equal(out.shareJson, JSON.stringify(out.share));
    assert.equal(out.filename, "realmid-share-realm_x-split-1.json");
  });

  it("default kid is split-<yyyymmdd>-<8hex>", async () => {
    const out = await dealSplitKey({ realm: "r" });
    assert.match(out.kid, /^split-\d{8}-[0-9a-f]{8}$/);
    assert.equal(out.upload.kid, out.kid);
    assert.deepEqual(Object.keys(out.share.shares), [out.kid]);
  });

  it("an empty realm or a blank kid is bad_request", async () => {
    await assert.rejects(dealSplitKey({ realm: "" }), (e: unknown) => e instanceof RealmError && e.code === "bad_request");
    await assert.rejects(dealSplitKey({ realm: "r", kid: "  " }), (e: unknown) => e instanceof RealmError && e.code === "bad_request");
  });

  it("missing WebCrypto, a rejecting generateKey, or a JWK without p/q is split_keygen_unsupported", async () => {
    const cases: Crypto[] = [
      {} as Crypto,
      { subtle: { generateKey: async () => { throw new Error("no rsa"); } } } as unknown as Crypto,
      {
        subtle: {
          generateKey: async () => ({ privateKey: {}, publicKey: {} }),
          exportKey: async () => ({ n: "AQAB", e: "AQAB" }),
        },
        getRandomValues: crypto.getRandomValues.bind(crypto),
      } as unknown as Crypto,
    ];
    for (const c of cases) {
      await assert.rejects(dealSplitKey({ realm: "r", crypto: c }), (e: unknown) => {
        assert.ok(e instanceof RealmError);
        assert.equal(e.code, "invalid_config");
        assert.equal((e.details as Record<string, unknown>)["reason"], "split_keygen_unsupported");
        return isSplitKeygenUnsupported(e);
      });
    }
    assert.equal(isSplitKeygenUnsupported(new Error("x")), false);
    assert.equal(isSplitKeygenUnsupported(new RealmError({ code: "invalid_config", message: "x" })), false);
  });

  it("the pure split module is not re-exported from the entry point", () => {
    assert.equal((entry as Record<string, unknown>)["splitWithDRi"], undefined);
    assert.equal(typeof (entry as Record<string, unknown>)["dealSplitKey"], "function");
    assert.equal(typeof (entry as Record<string, unknown>)["isSplitKeygenUnsupported"], "function");
  });
});

describe("signingKeys.uploadSplitKey", () => {
  it("POSTs the body exactly to /platforms/{id}/signing-keys/split and returns the answer", async () => {
    const calls: RequestOptions[] = [];
    const http: HttpLike = {
      async request<T>(opts: RequestOptions): Promise<T> {
        calls.push(opts);
        return { status: "uploaded", kid: "k1" } as T;
      },
    };
    const body = { kid: "k1", n: "bg", e: "AQAB", d_ri: "ZA" };
    const out = await new SigningKeysClient(http).uploadSplitKey("p 1", body);
    assert.deepEqual(out, { status: "uploaded", kid: "k1" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.path, "/platforms/p%201/signing-keys/split");
    assert.deepEqual(calls[0]!.body, body);
  });
});

describe("package rules", () => {
  it("no node: import and no Buffer in non-test src or in dist", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js|d\.ts)$/.test(f) && !/\.test\.(ts|js)$/.test(f)) files.push(p);
      }
    };
    walk("src");
    try { walk("dist"); } catch { /* dist is built by `npm run build`; the release gate greps it too */ }
    assert.ok(files.length > 10, `examined ${files.length} files`);
    const bad = files.filter((f) => /node:|\bBuffer\b/.test(readFileSync(f, "utf8")));
    assert.deepEqual(bad, []);
    for (const f of ["split-dealer.ts", "split-math.ts"]) {
      assert.ok(!/@realm-id\/sdk\/split/.test(readFileSync(join("src", f), "utf8")), f);
    }
  });
});
