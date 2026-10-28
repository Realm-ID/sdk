import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { createPublicKey, createVerify, publicDecrypt, constants } from "node:crypto";
import { RealmError } from "./errors.js";
import { ShareEntry, completePartial, completeHandshake, coSign, createSplitRealm } from "./split.js";
import {
  SplitKey, FakeIssuer, MemShares, jsonReply, userClaims, verifyRS256, b64u, fromB64u, b64big, hexBytes, toHex, toBig, sha256,
  TEST_REALM, bundleJSON,
} from "./split-testutil.test.js";

// SPEC14_2 / 14_3 / 14_6. Vectors: sdk/testdata/split-vectors (hex big integers), see its README.

interface Vectors {
  key: { n: string; e: number; d_partner: string };
  jwt_cases: { name: string; signing_input: string; s_ri: string; s: string; jwt: string }[];
  handshake: { realm: string; kid: string; nonce: string; message: string; s_ri: string; s: string };
  negative_cases: { name: string; rejected_jwt: string }[];
}

function loadVectors() {
  const v = JSON.parse(readFileSync(new URL("../../testdata/split-vectors/vectors.json", import.meta.url), "utf8")) as Vectors;
  const n = toBig(hexBytes(v.key.n));
  const entry = new ShareEntry({ n: b64big(n), e: b64big(BigInt(v.key.e)), d_partner: b64big(toBig(hexBytes(v.key.d_partner))) });
  const pub = createPublicKey({ key: { kty: "RSA", n: b64u(hexBytes(v.key.n)), e: b64u(Uint8Array.from([1, 0, 1])) }, format: "jwk" });
  return { v, entry, pub, n };
}

const stockVerify = (pub: ReturnType<typeof createPublicKey>, input: string, sig: Uint8Array): boolean =>
  createVerify("RSA-SHA256").update(input).verify(pub, sig);

test("cosign: every vector signature verifies under a stock RSA verifier (fixture guard, green today)", () => {
  const { v, pub } = loadVectors();
  assert.equal(v.jwt_cases.length, 5, `examined ${v.jwt_cases.length} jwt cases, want 5`);
  for (const c of v.jwt_cases) assert.ok(stockVerify(pub, c.signing_input, hexBytes(c.s)), c.name);
  // the handshake message is the digest itself: check the DigestInfo by public-key decryption
  const dec = publicDecrypt({ key: pub, padding: constants.RSA_PKCS1_PADDING }, hexBytes(v.handshake.s));
  assert.equal(toHex(dec), "3031300d060960864801650304020105000420" + v.handshake.message);
  assert.equal(v.negative_cases.length > 0, true);
  for (const n of v.negative_cases) {
    const [h, p, s] = n.rejected_jwt.split(".");
    assert.equal(stockVerify(pub, `${h}.${p}`, fromB64u(s!)), false, `negative ${n.name} verifies`);
  }
});

test("cosign: completePartial reproduces every vector signature", async () => {
  const { v, entry, pub } = loadVectors();
  for (const c of v.jwt_cases) {
    const sig = await completePartial(entry, c.signing_input, hexBytes(c.s_ri));
    assert.equal(toHex(sig), c.s, `${c.name}: combined signature differs from vector s`);
    assert.ok(stockVerify(pub, c.signing_input, sig), `${c.name}: result does not verify under a stock verifier`);
  }
});

test("cosign: completePartial refuses corrupt, zero and another message's partial (control first)", async () => {
  const { v, entry } = loadVectors();
  const c = v.jwt_cases[0]!;
  const good = await completePartial(entry, c.signing_input, hexBytes(c.s_ri));
  assert.equal(toHex(good), c.s, "control: the good partial must complete");
  const bad = hexBytes(c.s_ri);
  bad[100] = bad[100]! ^ 0x01;
  await assert.rejects(completePartial(entry, c.signing_input, bad), RealmError, "corrupted partial_ri accepted");
  await assert.rejects(completePartial(entry, c.signing_input, new Uint8Array(256)), RealmError, "zero partial_ri accepted");
  await assert.rejects(completePartial(entry, c.signing_input, hexBytes(v.jwt_cases[1]!.s_ri)), RealmError,
    "partial_ri of another message accepted");
});

test("cosign: handshake vector (message used directly as the digest) [format inferred]", async () => {
  const { v, entry, n } = loadVectors();
  const h = v.handshake;
  const sig = await completeHandshake(entry, h.realm, h.kid, h.nonce, hexBytes(h.s_ri));
  assert.equal(toHex(sig), h.s, "handshake signature differs from vector");
  assert.equal(toHex(await sha256(`realmid-split-handshake/v1|${h.realm}|${h.kid}|${h.nonce}`)), h.message);
  assert.ok(n > 0n);
});

test("cosign: coSign releases the basic vector JWT byte for byte", async () => {
  const { v, entry } = loadVectors();
  const c = v.jwt_cases[0]!; // basic: typ JWT, iss https://auth.realmid.dev/r1
  const [header, payload] = c.signing_input.split(".") as [string, string];
  const got = await coSign(entry, "https://auth.realmid.dev/r1", { kid: "k1", header, payload, partialRi: b64u(hexBytes(c.s_ri)) });
  assert.equal(got, c.jwt);
});

test("cosign: coSign refuses a foreign iss and a foreign typ; control passes", async () => {
  const k = await SplitKey.make("k1");
  const iss = "https://auth.example/r1";
  const tok = await coSign(k.entry(), iss, await k.partialSigning({ iss, sub: "u" }));
  assert.ok(tok.split(".").length === 3, "control (good iss/typ) refused");
  await assert.rejects(coSign(k.entry(), iss, await k.partialSigning({ iss: "https://evil.example/r1", sub: "u" })),
    (e: unknown) => e instanceof RealmError, "foreign iss");
  await assert.rejects(coSign(k.entry(), iss, await k.partialSigning({ iss, sub: "u" }, "at+evil")),
    (e: unknown) => e instanceof RealmError, "foreign typ");
});

test("cosign: verify-before-release, a share of a different key yields no token (control first)", async () => {
  const k = await SplitKey.make("k1");
  const other = await SplitKey.make("k1");
  const iss = "https://auth.example/r1";
  const s = await k.partialSigning(userClaims(iss));
  assert.ok((await coSign(k.entry(), iss, s)).length > 0, "control: the right share must release a token");
  await assert.rejects(coSign(other.entry(), iss, s), (e: unknown) => e instanceof RealmError, "mismatched share released a token");
});

test("cosign: a share is never printed by String / JSON.stringify / util.inspect (redaction)", async () => {
  const k = await SplitKey.make("k1");
  const e = k.entry();
  const b = k.bundle("r1");
  const secret = e.d_partner;
  assert.ok(secret.length > 100, "fixture: d_partner is readable on the instance for the signer");
  for (const [what, s] of Object.entries({
    string: String(e), json: JSON.stringify(e), inspect: inspect(e, { depth: 5 }), tpl: `${e}`,
    bundleJson: JSON.stringify(b), bundleInspect: inspect(b, { depth: 5 }),
    spread: JSON.stringify({ ...e }),
  })) {
    assert.equal(s.includes(secret), false, `${what} printed d_partner`);
  }
  assert.ok(bundleJSON(b).includes(secret), "fixture: explicit serialisation still carries it (what a store writes)");
});

// SPEC14_2_partial: auth.token on a split realm calls /auth/token/partial, finishes the signature,
// verifies it, stores the rotated refresh token.
test("cosign: split realm auth.token uses the partial endpoint and finishes the JWT", async () => {
  const k = await SplitKey.make("split-1");
  const f = new FakeIssuer();
  const claims = userClaims(f.issuer);
  f.on("/auth/token/partial", async () => jsonReply(200, await k.partialAnswer(claims, "rt-rotated")));
  f.on("/auth/token", () => jsonReply(409, { error: { code: "split_signing_required", message: "x" } }));
  const realm = createSplitRealm({ ...f.cfg(), shareSource: new MemShares(k.bundle(TEST_REALM)) });
  const out = await realm.auth.token({ refreshToken: "rt-old", tenantId: "t1" });
  assert.equal(out.refreshToken, "rt-rotated", "rotated refresh token not returned");
  const parts = out.accessToken.split(".");
  assert.equal(parts.length, 3, `access token is not a finished JWT: ${out.accessToken}`);
  assert.ok(await verifyRS256(k.n, k.e, `${parts[0]}.${parts[1]}`, fromB64u(parts[2]!)), "finished token does not verify under the split key");
  const userMints = f.reqs("/auth/token").filter((r) => r.body?.grant_type !== "platform_api_key");
  assert.equal(userMints.length, 0, "a split realm minted a user token at /auth/token");
  const pr = f.reqs("/auth/token/partial");
  assert.equal(pr.length, 1);
  assert.equal(pr[0]!.auth, "Bearer ptok");
  assert.equal(pr[0]!.body?.refresh_token, "rt-old");
});

test("cosign: a split realm with a corrupt partial_ri releases no token", async () => {
  const k = await SplitKey.make("split-1");
  const f = new FakeIssuer();
  f.on("/auth/token/partial", async () => {
    const a = await k.partialAnswer(userClaims(f.issuer), "rt2");
    (a.signing as Record<string, unknown>).partial_ri = b64u(new Uint8Array(256));
    return jsonReply(200, a);
  });
  const realm = createSplitRealm({ ...f.cfg(), shareSource: new MemShares(k.bundle(TEST_REALM)) });
  await assert.rejects(realm.auth.token({ refreshToken: "rt", tenantId: "t1" }), RealmError);
});
