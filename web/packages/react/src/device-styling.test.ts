/**
 * RED tests for the styling ruling (owner, 2026-11-02): no Tailwind anywhere, and a small OPTIONAL default
 * stylesheet that is driven only by CSS custom properties. File-level checks, no DOM needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const packagesDir = join(pkgRoot, "..");

const DOCUMENTED = new Set([
  "--realmid-accent", "--realmid-accent-contrast", "--realmid-text", "--realmid-muted", "--realmid-surface",
  "--realmid-border", "--realmid-danger", "--realmid-radius", "--realmid-font", "--realmid-gap",
]);

function findCss(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) findCss(p, out);
    else if (e === "device-approval.css") out.push(p);
  }
  return out;
}

test("no package.json in the web workspace depends on Tailwind (or a CSS framework)", () => {
  for (const pkg of readdirSync(packagesDir)) {
    const f = join(packagesDir, pkg, "package.json");
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8"));
    const names = Object.keys({ ...j.dependencies, ...j.devDependencies, ...j.peerDependencies });
    const bad = names.filter((n) => /tailwind|bootstrap|styled-components|emotion|@mui\//i.test(n));
    assert.deepEqual(bad, [], `${pkg} depends on a CSS framework`);
  }
});

test("web-react exposes ./device-approval.css as an optional separate import", () => {
  const j = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  assert.ok(j.exports?.["./device-approval.css"], "package.json exports lacks ./device-approval.css");
});

test("the default stylesheet exists and reads ONLY the ten documented custom properties, each with a fallback", () => {
  const files = findCss(pkgRoot);
  assert.equal(files.length, 1, "device-approval.css not found under web/packages/react (excluding dist)");
  const css = readFileSync(files[0], "utf8");
  assert.doesNotMatch(css, /@import|@tailwind|@apply|theme\(/);
  const vars = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/gi)];
  assert.ok(vars.length > 0, "the stylesheet uses no custom property at all");
  for (const [, name, comma] of vars) {
    assert.ok(DOCUMENTED.has(name), `${name} is not one of the documented custom properties`);
    assert.ok(comma, `var(${name}) has no fallback`);
  }
  const used = new Set(vars.map((v) => v[1]));
  assert.ok(used.has("--realmid-accent"), "the accent property must drive the primary button");
  // Every rule selects by the stable realmid-device class (no element-wide leakage into the host page).
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, "").split("{").slice(0, -1).map((s) => s.split("}").pop()!.trim()).filter(Boolean);
  for (const s of selectors) {
    if (s.startsWith("@")) continue;
    assert.match(s, /realmid-device/, `selector '${s}' is not scoped to .realmid-device`);
  }
});

test("a build-free guard: every documented stable class name appears in the component source", () => {
  const src = readdirSync(here).filter((f) => /^DeviceApproval\.tsx?$|^device-approval\.tsx?$/.test(f));
  assert.ok(src.length > 0, "no DeviceApproval source file in web/packages/react/src");
  const text = src.map((f) => readFileSync(join(here, f), "utf8")).join("\n");
  for (const c of ["realmid-device", "realmid-device__title", "realmid-device__code-form", "realmid-device__code-input",
    "realmid-device__details", "realmid-device__detail", "realmid-device__notice", "realmid-device__choice",
    "realmid-device__sessions", "realmid-device__mfa-form", "realmid-device__actions", "realmid-device__button--primary",
    "realmid-device__button--secondary", "realmid-device__error", "realmid-device__countdown"]) {
    assert.ok(text.includes(c), `class ${c} not found in the component source`);
  }
});
