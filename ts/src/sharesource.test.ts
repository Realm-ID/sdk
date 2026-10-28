import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealmError } from "./errors.js";
import { envShareSource, fileShareSource, type WritableShareSource } from "./split.js";
import { SplitKey, bundleJSON } from "./split-testutil.test.js";

// SPEC14_5_shares: core sources are env (read-only) and file (atomic, 0600, KEK outside local dev).
// The temp dir comes from os.tmpdir(); run with TMPDIR set inside the workspace's .scratch/.

const tmp = (): string => mkdtempSync(join(tmpdir(), "ri-shares-"));
const ENV = "RI_TEST_SHARE_BUNDLE";

test("sharesource: env loads the bundle and is read-only", async () => {
  const k = await SplitKey.make("split-1");
  const src = envShareSource(ENV, { env: { [ENV]: bundleJSON(k.bundle("r1")) } });
  const { bundle, version } = await src.load();
  assert.equal(bundle.shares["split-1"]?.d_partner, k.entry().d_partner);
  assert.ok(version.length > 0, "empty version");
  assert.equal("store" in src, false, "env source must be read-only (no store)");
});

test("sharesource: env unset or malformed is an error (control first)", async () => {
  const k = await SplitKey.make("split-1");
  await envShareSource(ENV, { env: { [ENV]: bundleJSON(k.bundle("r1")) } }).load(); // control
  await assert.rejects(envShareSource(ENV, { env: { [ENV]: "" } }).load(), RealmError, "unset env");
  await assert.rejects(envShareSource(ENV, { env: { [ENV]: "{not json" } }).load(), RealmError, "malformed env");
});

test("sharesource: file round trip, mode 0600, atomic, version changes per write", async () => {
  const dir = tmp();
  const path = join(dir, "shares.json");
  const src = fileShareSource(path, { localDev: true });
  const k = await SplitKey.make("split-1");
  const v1 = await src.store(k.bundle("r1"));
  const got = await src.load();
  assert.equal(got.bundle.shares["split-1"]?.d_partner, k.entry().d_partner);
  assert.equal(got.version, v1);
  assert.equal(statSync(path).mode & 0o777, 0o600, "file mode is not 0600");
  const k2 = await SplitKey.make("split-2");
  const b2 = k.bundle("r1");
  b2.shares["split-2"] = k2.entry();
  const v2 = await src.store(b2);
  assert.notEqual(v2, v1, "version did not change on write");
  assert.equal(readdirSync(dir).length, 1, "atomic rename left a stray entry in the directory");
});

test("sharesource: file needs a KEK outside local dev (control first)", () => {
  const path = join(tmp(), "shares.json");
  fileShareSource(path, { localDev: true }); // control: local dev constructs
  assert.throws(() => fileShareSource(path, {}), (e: unknown) => e instanceof RealmError && e.code === "invalid_config");
});

test("sharesource: a KEK encrypts at rest and a wrong KEK cannot load", async () => {
  const path = join(tmp(), "shares.json");
  // SPEC 14.5 / 14.9 (R93): the realm is a source INPUT with a KEK (the envelope AAD binds it).
  const src: WritableShareSource = fileShareSource(path, { kek: new Uint8Array(32).fill(7), realm: "r1" });
  const k = await SplitKey.make("split-1");
  await src.store(k.bundle("r1"));
  assert.equal(readFileSync(path).toString("latin1").includes(k.entry().d_partner), false, "d_partner is in the file in the clear");
  assert.equal((await src.load()).bundle.shares["split-1"]?.d_partner, k.entry().d_partner);
  await assert.rejects(fileShareSource(path, { kek: new Uint8Array(32).fill(9), realm: "r1" }).load(), RealmError, "wrong KEK loaded the bundle");
});
