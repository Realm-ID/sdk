import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalMatch, type MatchKind } from "./middleware.js";
import { validateScopePolicy } from "./scope.js";

// Runs every case of testdata/glob-boundary-vectors/vectors.json (SPEC §10.2 boundary table).
interface Vectors {
  matcher_case_count: number;
  matcher: { id: string; kind: MatchKind; pattern: string; path: string; match: boolean }[];
}
const v = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../testdata/glob-boundary-vectors/vectors.json", import.meta.url)), "utf8")) as Vectors;

test("glob-boundary vectors: every case", () => {
  let ran = 0, failed = 0;
  for (const c of v.matcher) {
    ran++;
    if (canonicalMatch(c.pattern, c.kind, c.path) !== c.match) {
      failed++;
      console.error("glob-boundary case failed", c.id, c.pattern, c.kind, c.path, "want", c.match);
    }
  }
  console.log(`glob-boundary-vectors ts: ran ${ran}, ${failed} failed`);
  assert.ok(ran > 0, "zero cases");
  assert.equal(ran, v.matcher_case_count);
  assert.equal(failed, 0);
});

test("validateScopePolicy reports a malformed {...} placeholder", () => {
  const bad = ["/a/{id", "/a/id}", "/a/{}", "/a/{x:.*}", "/a/x{id}", "/a/{id}y", "/a/{a b}"];
  for (const path of bad) {
    const errs = validateScopePolicy([{ path, scopes: ["orders:read"] }]);
    assert.equal(errs.length, 1, `${path}: ${JSON.stringify(errs)}`);
    assert.equal(errs[0]!.path, path);
  }
  assert.deepEqual(validateScopePolicy([{ path: "/a/{id}", scopes: ["orders:read"] }]), []);
});
