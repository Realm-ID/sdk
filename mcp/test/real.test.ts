// Positive controls against the REAL bundled docs (src/generated/index.json, built by
// scripts/build-index.mjs from the sdk tree). Fixture tests prove the logic; these prove the
// logic finds things in the actual documents, which a fixture cannot.
import { describe, expect, it } from "vitest";
import index from "../src/generated/index.json";
import type { DocsIndex } from "../src/types";
import { explainError, getClaim, searchDocs } from "../src/tools";

const idx = index as unknown as DocsIndex;

describe("real docs", () => {
  it("indexes a non-trivial amount (a check that examined nothing is not evidence)", () => {
    expect(idx.sections.length).toBeGreaterThan(50);
    expect(idx.errors.length).toBeGreaterThan(20);
    expect(idx.claims.length).toBeGreaterThan(5);
    expect(idx.source.commit).toMatch(/^[0-9a-f]{7,40}$/);
  });
  it("explain_error('tenant_required') returns its row", () => {
    const r = explainError(idx, "tenant_required");
    expect(r.ok && r.error.description).toMatch(/tenantId/);
    expect(r.ok && r.error.url).toContain("error-reference.md#auth-flow-codes");
  });
  it("search_docs('bring your own user id') returns the FAQ's BYO-id section", () => {
    const r = searchDocs(idx, "bring your own user id");
    expect(r.results.map((x) => x.anchor).slice(0, 3)).toContain("can-i-bring-my-own-user-ids");
    expect(r.results[0].url).toMatch(/^https:\/\/github\.com\/Realm-ID\/sdk\/blob\/main\/docs\/migrating-to-realmid\.md#/);
  });
  it("get_claim finds a known claim", () => {
    expect(getClaim(idx, "user-id-byo-uuid").ok).toBe(true);
  });
});
