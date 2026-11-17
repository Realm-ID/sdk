# Glob-boundary vectors (normative)

Shared cases for how `**` keeps its segment boundary in the ONE canonical path
matcher: `sdk/SPEC.md` §10.2 (path syntax and its boundary table) and §11.4.1
(`SPEC11_4_1_canon`). They cover the shapes `testdata/path-match-vectors` does
not: a pattern that STARTS with `**/`, and a `**` that shares its segment with a
literal (`/a/**b`, `/static/**.js`). These cases ARE the contract: when a
language disagrees with a case, the language is wrong, and a case changes only
with a SPEC change in the same commit.

## The rule

A `**` never drops a `/` written in the pattern.

- A `**` that fills a whole segment (`/a/**/b`, `/x/**`, `/**`) stands for zero
  or more whole segments.
- A pattern that starts with `**/` is read as `/**/`: `**/health` matches
  `/health` and `/api/health`, never `/api/nothealth`.
- A `**` that shares its segment with a literal matches any run of characters,
  `/` included, and the `/` before it stays: `/static/**.js` matches
  `/static/app.js` and `/static/js/app.js`, never `/static.js`.

## Format (`vectors.json`)

`matcher[]`: `{id, kind, pattern, path, match, why}`, exactly the shape of
`testdata/path-match-vectors/vectors.json` § `matcher`. Call the language's
canonical matcher with `(pattern, kind, path)` and assert `match`. `kind` is
`exempt`, `mfa` or `scope`; every kind gets the same answer here.
`matcher_case_count` is how many cases the file holds.

## How a runner reports (MUST)

One line, after every case has run:

```
glob-boundary-vectors <lang>: ran <M> cases, <F> failed
```

and FAIL (a test failure, not a skip) when it ran zero cases, when `M` differs
from `matcher_case_count`, or when any case failed. A runner never skips a case
for its language.

## Which test consumes it

Each language's drift test MUST run every case in this file, beside the
path-match runners, reading it by a path relative to the repo root (it sits
OUTSIDE `go/` on purpose: a file inside the Go module changes the module hash;
never copy it into `go/`):

| Language | Test that must run it |
|---|---|
| go | `go/path_match_vectors_test.go` (a second test function reading `../testdata/glob-boundary-vectors/vectors.json`) |
| ts | `ts/src/path-match-vectors.test.ts` (a second `describe` block) |
| java | `java/src/test/java/dev/realmid/sdk/middleware/PathMatchVectorsTest.java` (a second test method) |
