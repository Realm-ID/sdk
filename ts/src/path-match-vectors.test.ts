import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalMatch, pathOnly, type MatchKind } from "./middleware.js";
import { requestPathOf } from "./scope.js";

// path-match-vectors.test.ts — audit e-04 (ts). Spec: sdk/SPEC.md SPEC11_4_1_canon (the matcher)
// and SPEC11_4_1_source (the path each language hands it; ts keeps the RAW path, owner ruling 9).
// Vectors: testdata/path-match-vectors/vectors.json.

interface Vectors {
  matcher_case_count: number;
  request_case_count: number;
  matcher: { id: string; kind: MatchKind; pattern: string; path: string; match: boolean }[];
  request_rules: { mfa: string[] };
  request: { id: string; target: string; ts: { seen: string; mfa_rule: string | null } }[];
}
const v = JSON.parse(readFileSync(
  fileURLToPath(new URL("../../testdata/path-match-vectors/vectors.json", import.meta.url)), "utf8")) as Vectors;

test("path-match vectors: matcher + request (middleware source and scope-adapter source)", () => {
  let m = 0, r = 0, failed = 0;
  for (const c of v.matcher) {
    m++;
    if (canonicalMatch(c.pattern, c.kind, c.path) !== c.match) { failed++; console.error("matcher case failed", c.id); }
  }
  const firstRule = (seen: string): string | null =>
    v.request_rules.mfa.find((p) => canonicalMatch(p, "mfa", seen)) ?? null;
  for (const c of v.request) {
    r++;
    const sources = [
      pathOnly(c.target),
      // the scope adapter: req.path (query removed) when present, else originalUrl
      requestPathOf({ path: c.target.split("?")[0], url: c.target }),
      requestPathOf({ originalUrl: c.target }),
    ];
    for (const seen of sources) {
      if (seen !== c.ts.seen) { failed++; console.error("request seen failed", c.id, seen); }
      else if (firstRule(seen) !== c.ts.mfa_rule) { failed++; console.error("request mfa_rule failed", c.id); }
    }
  }
  console.log(`path-match-vectors ts: ran ${m} matcher + ${r} request cases, ${failed} failed`);
  assert.ok(m > 0 && r > 0, "zero cases");
  assert.equal(m, v.matcher_case_count);
  assert.equal(r, v.request_case_count);
  assert.equal(failed, 0);
});

test("canonicalMatch: exempt keeps braces literal, mfa/scope treat them as a placeholder", () => {
  assert.equal(canonicalMatch("/a/{id}", "exempt", "/a/{id}"), true);
  assert.equal(canonicalMatch("/a/{id}", "exempt", "/a/42"), false);
  assert.equal(canonicalMatch("/a/{id}", "scope", "/a/42"), true);
});
