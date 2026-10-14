import { describe, expect, it } from "vitest";
import { parseErrorCodes, parseSections, slugBase, splitRow } from "../scripts/lib.mjs";

describe("anchors", () => {
  it("slugs like GitHub", () => {
    expect(slugBase("Can I bring my own user ids?")).toBe("can-i-bring-my-own-user-ids");
    expect(slugBase("7.3 Bulk import mechanics (POST /tenants/{id}/users/import, ADR-073)")).toBe(
      "73-bulk-import-mechanics-post-tenantsidusersimport-adr-073",
    );
  });
  it("suffixes duplicates and ignores headings in code fences", () => {
    const s = parseSections("# A\n\n## Dup\n\n## Dup\n\n```\n# not a heading\n```\n");
    expect(s.map((x) => x.anchor)).toEqual(["a", "dup", "dup-1"]);
  });
});

describe("error tables", () => {
  const md = [
    "## One",
    "| Code | When | What to do |",
    "|---|---|---|",
    "| `a_code` | when `x | y` happens | do it |",
    "",
    "## Two",
    "| Code | Meaning | What to do |",
    "|---|---|---|",
    "| `b_code` | it means | act |",
  ].join("\n");
  it("reads both header shapes", () => {
    const rows = parseErrorCodes(md);
    expect(rows.map((r) => [r.code, r.kind, r.anchor])).toEqual([
      ["a_code", "When", "one"],
      ["b_code", "Meaning", "two"],
    ]);
  });
  it("keeps a pipe inside backticks in its cell", () => {
    expect(parseErrorCodes(md)[0].description).toBe("when `x | y` happens");
    expect(splitRow("| a | `b|c` | d |")).toEqual(["a", "`b|c`", "d"]);
  });
});
