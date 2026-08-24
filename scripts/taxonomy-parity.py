#!/usr/bin/env python3
"""Cross-language parity gate for the SPEC §3.1 error-code taxonomy.

THE FAULT THIS EXISTS FOR. `sdk/TODO.md` recorded the taxonomy as "consistent
across the three SDKs, so no language is the outlier; that is why it reads as
intentional and may be." Measured on 2026-08-24 it was EIGHT codes out of sync:

  in ts + Java, absent from Go   handle_taken, invalid_role,
                                 method_violates_kind, service_account_not_found,
                                 source_not_found, user_not_found
  in Go, absent from ts + Java   mfa_registration_required
  in ts + Java, emitted NOWHERE  not_service

An unregistered code does not fail — `mapErrorResponse` falls back to the HTTP
status, so the caller gets `not_found` / `bad_request` and the specific remedy
is silently lost. Nothing breaks, nothing logs, and the drift is invisible until
someone diffs three files in three languages by hand.

Worse, "all three agree" was used as EVIDENCE OF INTENT. It is not evidence of
anything: the three lists are maintained by hand from one SPEC, so a single
omission propagates identically to all three, and agreement is exactly what a
shared oversight looks like. This gate replaces that inference with a
measurement.

WHAT IT CHECKS
  1. The three taxonomies are set-equal, modulo the reviewed exceptions below.
  2. Go's `knownCodes` map covers every `ErrCode*` const it declares — a SECOND
     hand-maintained list in the same file, where a const that never reaches the
     map is registered in name only.
  3. It parsed a plausible number of codes from every language. A regex that
     stops matching after a refactor would otherwise report perfect parity
     across three empty sets.

Exit 0 = parity, 1 = drift, 2 = parse/usage error.
"""
import os
import re
import sys

# Reviewed exceptions. An entry here is a DECISION with a reason, not a
# silenced failure — the gate prints it every run so it cannot rot unnoticed.
EXCEPTIONS = {
    "not_service": (
        "declared by ts + Java, emitted by NO issuer handler (its only "
        "near-match is the distinct `role_not_service_typed`). Deliberately "
        "not propagated to Go: a code with no producer is a phantom. Removing "
        "it from ts/Java is safe in principle — nothing can be matching a code "
        "that never arrives — but it is a SPEC change and is filed, not "
        "smuggled in here."
    ),
}

# Each language's list, read from the file that actually compiles.
SOURCES = {
    "ts":   ("ts/src/errors.ts", None),
    "go":   ("go/errors.go", None),
    "java": ("java/src/main/java/dev/realmid/sdk/ErrorCode.java", None),
}
MIN_CODES = 40  # sanity floor; the taxonomy has ~60 and only ever grows


def die(msg, code=2):
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(code)


def read(path):
    if not os.path.exists(path):
        die(f"{path} does not exist — run this from the sdk repo root")
    return open(path, encoding="utf-8").read()


def ts_codes():
    src = read(SOURCES["ts"][0])
    # The union only; KNOWN_CODES is checked separately below.
    # Anchored on the exact declaration: splitting on the bare prefix
    # "export type ErrorCode" also matches `export type ErrorCodeX`, so a
    # renamed union kept parsing and the gate reported parity. Found by
    # mutating the name.
    m = re.search(r"export type ErrorCode\s*=", src)
    if not m:
        die("could not locate the ErrorCode union in ts/src/errors.ts")
    body = src[m.end():].split("export interface")[0]
    union = set(re.findall(r'\|\s*"([a-z_]+)"', body))
    known = set(re.findall(r'"([a-z_]+)"', src.split("const KNOWN_CODES")[1].split("]);")[0]))
    if union != known:
        for c in sorted(union - known):
            print(f"::error::ts: `{c}` is in the ErrorCode union but not in KNOWN_CODES, "
                  f"so isKnownCode() rejects it and it can never reach error.code")
        for c in sorted(known - union):
            print(f"::error::ts: `{c}` is in KNOWN_CODES but not in the ErrorCode union")
        die("ts/src/errors.ts disagrees with itself", 1)
    return union


def go_codes():
    src = read(SOURCES["go"][0])
    declared = dict(re.findall(r'(ErrCode[A-Za-z]+)\s+ErrorCode = "([a-z_]+)"', src))
    try:
        mapbody = src.split("var knownCodes = map[ErrorCode]struct{}{")[1].split("\n}")[0]
    except IndexError:
        die("could not locate knownCodes in go/errors.go")
    in_map = set(re.findall(r'(ErrCode[A-Za-z]+)\s*:', mapbody))
    missing = set(declared) - in_map
    if missing:
        for c in sorted(missing):
            print(f"::error::go: const {c} (\"{declared[c]}\") is declared but absent from "
                  f"knownCodes, so isKnownCode() rejects it — registered in name only")
        die("go/errors.go declares codes its knownCodes map does not hold", 1)
    return set(declared.values())


def java_codes():
    src = read(SOURCES["java"][0])
    # Enum constants only: NAME("wire"),
    return set(re.findall(r'^\s*[A-Z][A-Z0-9_]*\("([a-z_]+)"\)', src, re.M))


def main():
    langs = {"ts": ts_codes(), "go": go_codes(), "java": java_codes()}

    # (3) A regex that stopped matching would report parity across empty sets.
    for name, codes in langs.items():
        if len(codes) < MIN_CODES:
            die(f"{name}: parsed only {len(codes)} codes from {SOURCES[name][0]} "
                f"(expected >= {MIN_CODES}) — the parser is broken, not the taxonomy clean")

    everywhere = set.intersection(*langs.values())
    anywhere = set.union(*langs.values())
    drift = anywhere - everywhere

    print("## Error-code taxonomy parity")
    print()
    for name, codes in langs.items():
        print(f"- `{name}` declares **{len(codes)}** codes.")
    print(f"- **{len(everywhere)}** are present in all three.")
    for code, why in sorted(EXCEPTIONS.items()):
        print(f"- ⏭️  `{code}` — reviewed exception: {why}")
    print()

    unexplained = sorted(drift - set(EXCEPTIONS))
    if not unexplained:
        print("Parity holds.")
        return 0

    print("**TAXONOMY DRIFT.** A code missing from a language does not fail there —")
    print("`mapErrorResponse` falls back to the HTTP status, so the caller silently")
    print("gets a generic code and the specific remedy is lost.")
    print()
    print("| code | ts | go | java |")
    print("|---|---|---|---|")
    for code in unexplained:
        row = " | ".join("✅" if code in langs[n] else "**MISSING**" for n in ("ts", "go", "java"))
        print(f"| `{code}` | {row} |")
        print(f"::error::taxonomy drift: `{code}` is not declared in every language")
    print()
    print("Add it everywhere, or add it to EXCEPTIONS in this script WITH A REASON.")
    return 1


if __name__ == "__main__":
    rc = main()
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        pass  # output is already on stdout; the workflow tees it
    sys.exit(rc)
