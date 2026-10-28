import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import * as sdk from "./index.js";

// SPEC 14.9 / F5: split signing and the share sources are a SERVER-ONLY entry point. The browser
// packages (sdk/web/packages/*) import `@realm-id/sdk` (the "." entry), so the split code must be
// (a) a separate subpath export, (b) unreachable from index.ts, and (c) never imported by a browser
// package. ts form of the Go/java "structurally excluded" check: package exports + an import-graph walk.

const SRC = new URL("./", import.meta.url).pathname;
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Module specifiers a file imports, re-exports, or `import()`s. */
function specifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteral(a)) out.push(a.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function reachableFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    const specs = specifiers(f);
    seen.set(f, specs);
    for (const s of specs) {
      if (!s.startsWith(".")) continue;
      const target = join(SRC, s.replace(/^\.\//, "").replace(/\.js$/, ".ts"));
      if (existsSync(target)) queue.push(target);
    }
  }
  return seen;
}

const SPLIT_FILE = /(^|\/)(split|share|cosign|rotation|integration-handler)[^/]*\.ts$/;

test("browser-exclusion: the split code is a separate server-only subpath export", () => {
  const ex = PKG.exports as Record<string, Record<string, string>>;
  assert.ok(ex["./split"], 'package.json exports has no "./split" subpath for the server-only code');
  assert.equal(ex["./split"]!.import, "./dist/split.js");
  assert.equal(ex["./split"]!.types, "./dist/split.d.ts");
  assert.ok(existsSync(join(SRC, "split.ts")), "src/split.ts (the barrel) is missing");
  for (const [k, v] of Object.entries(ex["."]!)) assert.equal(/split|share|cosign/.test(v), false, `"." ${k} points at split code`);
});

test("browser-exclusion: nothing reachable from index.ts is split code or a node builtin", () => {
  const graph = reachableFrom(join(SRC, "index.ts"));
  assert.ok(graph.size >= 50, `examined only ${graph.size} reachable modules; the walk is not following the package`);
  const split = [...graph.keys()].filter((f) => SPLIT_FILE.test(f));
  assert.deepEqual(split, [], "split/share-source modules are reachable from the browser-facing entry");
  const node = [...graph.entries()].flatMap(([f, specs]) =>
    specs.filter((s) => s.startsWith("node:") || ["fs", "path", "os", "crypto"].includes(s)).map((s) => `${f}: ${s}`));
  assert.deepEqual(node, [], "a node builtin is imported from the browser-facing entry");
});

test("browser-exclusion: index.ts does not export any split symbol", () => {
  const names = Object.keys(sdk);
  assert.ok(names.length >= 20, `examined only ${names.length} exports`);
  for (const bad of ["createSplitRealm", "rotateSplit", "coSign", "completePartial", "completeHandshake",
    "fileShareSource", "envShareSource", "ShareEntry", "createIntegrationTokenHandler"]) {
    assert.equal(names.includes(bad), false, `index.ts exports ${bad}`);
  }
});

test("browser-exclusion: no browser package imports the split entry", () => {
  const root = new URL("../../web/packages/", import.meta.url).pathname;
  const pkgs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  let files = 0;
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        files++;
        if (/@realm-id\/sdk\/split/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    }
  };
  for (const p of pkgs) if (existsSync(join(root, p.name, "src"))) walk(join(root, p.name, "src"));
  assert.ok(files >= 20, `examined only ${files} browser-package files`);
  assert.deepEqual(hits, []);
});
