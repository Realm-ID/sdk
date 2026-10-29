import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealmError } from "./errors.js";
import { rotateSplit, fileShareSource, envShareSource } from "./split.js";
import {
  SplitKey, FakeIssuer, MemShares, jsonReply, emsaFromDigest, modPow, sha256, fromB64u, fromBig, toBig, b64u, TEST_REALM,
} from "./split-testutil.test.js";

// SPEC14_12_ci_rotation / 14.5. The handshake wire ({nonce, partial_ri} out, {sig} in) is [inferred]
// from the vectors README; swagger says only "returns a challenge".

const base = `/platforms/${TEST_REALM}/signing-keys/split`;

function splitRoutes(f: FakeIssuer, handshakeOK: boolean): Record<string, any>[] {
  const ups: Record<string, any>[] = [];
  f.on(`${base}/rotation-lease`, () => jsonReply(200, { lease_id: "l1", expires_at: "2026-10-29T00:00:00Z" }));
  f.on(base, (r) => { ups.push(r.body!); return jsonReply(200, { status: "uploaded" }); });
  f.on(`${base}/k2/handshake`, async () => {
    const up = ups[ups.length - 1]!;
    const n = toBig(fromB64u(up.n));
    const dRI = toBig(fromB64u(up.d_ri));
    const nonce = "bm9uY2U";
    const msg = await sha256(`realmid-split-handshake/v1|${TEST_REALM}|k2|${nonce}`);
    return jsonReply(200, { nonce, partial_ri: b64u(fromBig(modPow(emsaFromDigest(msg), dRI, n), 256)) });
  });
  f.on(`${base}/k2/handshake/complete`, () =>
    handshakeOK ? jsonReply(200, { status: "ok" }) : jsonReply(401, { error: { code: "handshake_failed", message: "no" } }));
  return ups;
}

const nonMint = (f: FakeIssuer) => f.seen.filter((s) => s.path !== "/auth/token" && s.path !== "/platforms/mine");

test("rotation: file store happy path, order, platform token and no actor", async () => {
  const f = new FakeIssuer();
  const ups = splitRoutes(f, true);
  const old = await SplitKey.make("k1");
  const src = fileShareSource(join(mkdtempSync(join(tmpdir(), "ri-rot-")), "s.json"), { localDev: true });
  await src.store(old.bundle(TEST_REALM));
  await rotateSplit(f.realm(), src, { kid: "k2" });
  const want = [`POST ${base}/rotation-lease`, `POST ${base}`, `POST ${base}/k2/handshake`, `POST ${base}/k2/handshake/complete`];
  assert.deepEqual(nonMint(f).map((s) => `${s.method} ${s.path}`), want);
  for (const s of nonMint(f)) {
    assert.equal(s.auth, "Bearer ptok", `${s.path}: rotation is the platform token (R67.3)`);
    assert.equal(s.userToken, "", `${s.path}: no actor (R67.3)`);
  }
  assert.equal(ups.length, 1);
  const { bundle } = await src.load();
  const e = bundle.shares["k2"];
  assert.ok(e, "new share not stored");
  // d_ri + d_partner must be a working private exponent for (n, e)
  const n = toBig(fromB64u(e!.n));
  const d = toBig(fromB64u(ups[0]!.d_ri)) + toBig(fromB64u(e!.d_partner));
  const m = 123456789n;
  assert.equal(modPow(modPow(m, d, n), 65537n, n), m, "d_ri + d_partner is not the private exponent of the uploaded key");
  assert.equal(bundle.previous?.length, 1, "rotation must keep k1 as previous");
  assert.equal(bundle.previous![0]!.kid, "k1");
  assert.ok(bundle.previous![0]!.trust_until > 0, "previous key has no trust_until");
});

test("rotation: recovery keeps no previous key", async () => {
  const f = new FakeIssuer();
  splitRoutes(f, true);
  const src = new MemShares((await SplitKey.make("k1")).bundle(TEST_REALM));
  await rotateSplit(f.realm(), src, { kid: "k2", recovery: true });
  assert.ok(src.b.shares["k2"], "recovery stored no new share");
  assert.equal(src.b.previous?.length ?? 0, 0, "recovery = no overlap");
});

test("rotation: a handshake failure stops and does not loop", async () => {
  const f = new FakeIssuer();
  splitRoutes(f, false);
  const src = new MemShares((await SplitKey.make("k1")).bundle(TEST_REALM));
  await assert.rejects(rotateSplit(f.realm(), src, { kid: "k2" }), RealmError);
  assert.equal(f.reqs(`${base}/k2/handshake/complete`).length, 1, "handshake/complete must be called exactly once (stop, never loop)");
  assert.equal(f.reqs(base).length, 1, "upload must be called once");
});

test("rotation: a held lease stops before keygen or upload", async () => {
  const f = new FakeIssuer();
  f.on(`${base}/rotation-lease`, () => jsonReply(409, { error: { code: "rotation_lease_held", message: "held" } }));
  const src = new MemShares((await SplitKey.make("k1")).bundle(TEST_REALM));
  await assert.rejects(rotateSplit(f.realm(), src, { kid: "k2" }),
    (e: unknown) => e instanceof RealmError && e.httpStatus === 409);
  assert.equal(f.reqs(base).length, 0, "uploaded despite a held lease");
  assert.equal(src.b.shares["k2"], undefined, "stored a new share despite a held lease");
});

test("rotation: an env source cannot rotate and nothing is sent", async () => {
  const f = new FakeIssuer();
  const src = envShareSource("RI_TEST_SHARE_BUNDLE", { env: { RI_TEST_SHARE_BUNDLE: '{"realm":"r","shares":{}}' } });
  await assert.rejects(rotateSplit(f.realm(), src, { kid: "k2" }),
    (e: unknown) => e instanceof RealmError && /read-only|writable/i.test(e.message));
  assert.deepEqual(nonMint(f), [], "env-source rotation sent a request");
});

test("rotation: the upload carries the lease_id the lease call returned", async () => {
  const f = new FakeIssuer();
  const ups = splitRoutes(f, true);
  const src = new MemShares((await SplitKey.make("k1")).bundle(TEST_REALM));
  await rotateSplit(f.realm(), src, { kid: "k2" });
  assert.equal(ups.length, 1);
  assert.equal(ups[0]!.lease_id, "l1");
});

test("rotation: a rotation_lease_held on upload surfaces and is not retried", async () => {
  const f = new FakeIssuer();
  f.on(`${base}/rotation-lease`, () => jsonReply(200, { lease_id: "l1", expires_at: "2026-10-29T00:00:00Z" }));
  f.on(base, () => jsonReply(409, { error: { code: "rotation_lease_held", message: "held" } }));
  const src = new MemShares((await SplitKey.make("k1")).bundle(TEST_REALM));
  await assert.rejects(rotateSplit(f.realm(), src, { kid: "k2" }),
    (e: unknown) => e instanceof RealmError && e.httpStatus === 409);
  assert.equal(f.reqs(base).length, 1, "upload must not be retried");
});
