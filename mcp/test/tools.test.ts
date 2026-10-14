import { describe, expect, it } from "vitest";
import { explainError, getClaim, getSection, searchDocs } from "../src/tools";
import { fixture } from "./fixtures/index";

describe("search_docs", () => {
  it("ranks the matching section first and carries anchor, url and snippet", () => {
    const r = searchDocs(fixture, "bring your own user id");
    expect(r.results[0].anchor).toBe("can-i-bring-my-own-user-ids");
    expect(r.results[0].url).toBe("https://github.com/Realm-ID/sdk/blob/main/docs/faq.md#can-i-bring-my-own-user-ids");
    expect(r.results[0].snippet.length).toBeGreaterThan(0);
  });
  it("returns nothing for a query that matches nothing", () => {
    expect(searchDocs(fixture, "zzzqqq").results).toEqual([]);
  });
  it("honours the limit and reports the source commit", () => {
    const r = searchDocs(fixture, "user id", 1);
    expect(r.results).toHaveLength(1);
    expect(r.source.commit).toBe("abc1234def");
  });
});

describe("get_section", () => {
  it("returns the full text", () => {
    const r = getSection(fixture, "faq", "does-realmid-support-scim");
    expect(r.ok && r.section.text).toContain("no SCIM route");
  });
  it("names the known anchors when the anchor is wrong", () => {
    const r = getSection(fixture, "faq", "nope");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("does-realmid-support-scim");
  });
  it("names the known docs when the doc is wrong", () => {
    const r = getSection(fixture, "nodoc", "x");
    expect(!r.ok && r.error).toContain("faq");
  });
});

describe("get_claim", () => {
  it("returns the claim with a public url", () => {
    const r = getClaim(fixture, "no-scim");
    expect(r.ok && r.claim.statement).toBe("RealmID has no SCIM route.");
    expect(r.ok && r.claim.sections[0].url).toBe("https://github.com/Realm-ID/sdk/blob/main/docs/faq.md#does-realmid-support-scim");
  });
  it("lists known ids on a miss", () => {
    const r = getClaim(fixture, "nope");
    expect(!r.ok && r.error).toContain("no-scim");
  });
});

describe("explain_error", () => {
  it("returns the row", () => {
    const r = explainError(fixture, "tenant_required");
    expect(r.ok && r.error.action).toBe("Surface a tenant picker.");
  });
  it("is case-insensitive and tolerates backticks", () => {
    expect(explainError(fixture, "`Tenant_Required`").ok).toBe(true);
  });
  it("says so for a code with no row", () => {
    const r = explainError(fixture, "missing_tenant_id");
    expect(!r.ok && r.error).toMatch(/no row/i);
  });
});
