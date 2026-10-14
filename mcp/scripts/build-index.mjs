#!/usr/bin/env node
// Bundles the sdk docs into src/generated/index.json. Run by `npm test`, `npm run dev` and the deploy
// workflow. Reads ../docs/*; never touches the network. The worker has NO runtime doc fetch: whatever
// is in this file is what it serves, and `source.commit` says which sdk commit it was built from.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseClaimLines, parseErrorCodes, parseSections } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sdkRoot = join(here, "..", "..");
const out = join(here, "..", "src", "generated", "index.json");
const REPO = "https://github.com/Realm-ID/sdk/blob/main";

const DOCS = [
  { id: "migrating-to-realmid", path: "docs/migrating-to-realmid.md", title: "Migrating to RealmID (FAQ)" },
  { id: "partner-integration-guide", path: "docs/partner-integration-guide.md", title: "Partner integration guide" },
  { id: "error-reference", path: "docs/error-reference.md", title: "Error reference" },
];

function git(...args) {
  try {
    return execFileSync("git", ["-C", sdkRoot, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const docs = [];
const sections = [];
const errors = [];
let claims = [];
for (const d of DOCS) {
  const file = join(sdkRoot, d.path);
  if (!existsSync(file)) throw new Error(`build-index: ${d.path} is missing under ${sdkRoot}`);
  const md = readFileSync(file, "utf8");
  docs.push({ id: d.id, title: d.title, path: d.path, url: `${REPO}/${d.path}` });
  for (const s of parseSections(md)) {
    if (!s.anchor) continue; // preamble before the first heading
    sections.push({ doc: d.id, ...s, url: `${REPO}/${d.path}#${s.anchor}` });
  }
  if (d.id === "error-reference") {
    for (const e of parseErrorCodes(md)) errors.push({ ...e, url: `${REPO}/${d.path}#${e.anchor}` });
  }
  if (d.id === "migrating-to-realmid") {
    claims = parseClaimLines(d.id, md).map((c) => ({
      id: c.id,
      source: "faq",
      statement: c.heading,
      doc: [`${d.path}#${c.anchor}`],
      heading: c.heading,
      text: c.text,
      url: `${REPO}/${d.path}#${c.anchor}`,
    }));
  }
}

// docs/claims.yaml, when it exists, is the authoritative claim list. Its exact shape is another
// author's to define, so accept a top-level list, a `claims:` list, or an id -> entry map, and keep
// each entry verbatim.
const claimsFile = join(sdkRoot, "docs", "claims.yaml");
let claimsSource = "faq-claim-lines";
if (existsSync(claimsFile)) {
  const y = parseYaml(readFileSync(claimsFile, "utf8"));
  const list = Array.isArray(y) ? y : Array.isArray(y?.claims) ? y.claims : null;
  const entries = list
    ? list.filter((e) => e && typeof e === "object" && e.id).map((e) => [String(e.id), e])
    : Object.entries(y?.claims ?? y ?? {}).filter(([, v]) => v && typeof v === "object");
  if (entries.length === 0) throw new Error("build-index: docs/claims.yaml parsed but holds no claims");
  docs.push({ id: "claims", title: "Claims", path: "docs/claims.yaml", url: `${REPO}/docs/claims.yaml` });
  claims = entries.map(([id, e]) => ({ source: "claims.yaml", url: `${REPO}/docs/claims.yaml`, ...e, id }));
  claimsSource = "claims.yaml";
}

const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--", "docs") !== "";
const index = {
  source: {
    repo: "Realm-ID/sdk",
    commit: commit || "unknown",
    dirty,
    built_at: new Date().toISOString(),
    claims_source: claimsSource,
  },
  docs,
  sections,
  errors,
  claims,
};
if (sections.length === 0 || errors.length === 0 || claims.length === 0) {
  throw new Error(`build-index: empty index (sections=${sections.length} errors=${errors.length} claims=${claims.length})`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(index));
console.log(
  `build-index: ${docs.length} docs, ${sections.length} sections, ${errors.length} error codes, ` +
    `${claims.length} claims (${claimsSource}) from ${index.source.commit.slice(0, 7)}${dirty ? "+dirty" : ""}`,
);
