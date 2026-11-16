# Path-match vectors (normative)

The shared cases for the ONE canonical path matcher every SDK implements:
`sdk/SPEC.md` §11.4.1, anchors `SPEC11_4_1_canon` (the matcher) and
`SPEC11_4_1_source` (the path each language hands it). Decided 2026-11-14 for
audit findings e-03 (java) and e-04 (ts); why in `sdk/DECISIONS.md` 2026-11-14.
These cases ARE the contract: when a language disagrees with a case, the
language is wrong, and a case changes only with a SPEC change in the same commit.

## Format (`vectors.json`)

- `matcher[]`: `{id, kind, pattern, path, match}`. Call the language's canonical
  matcher with `(pattern, kind, path)` and assert `match`. `kind` is `exempt`
  (`exemptPaths`), `mfa` (`mfaProtectedPaths`) or `scope` (`ScopeRule.path`);
  `{name}` is a placeholder only for `mfa` and `scope`. Every language gets the
  same answer; there are no per-language columns here.
- `request[]`: the path SOURCE. `target` is the request target on the wire.
  - **go** builds an `*http.Request` for `target` (e.g. `httptest.NewRequest`)
    and asserts the path its middleware and `ScopePolicy` pass to the matcher
    equals `go.seen`. `"400"` means `400 invalid_path` (SPEC11_4_1_source,
    owner rulings 9 and 16). The Go runner runs EVERY request case twice: as
    `httptest.NewRequest` builds it, and again with `r.RequestURI = ""` (the
    in-process fallback that scans `RawPath` and `EscapedPath()`). Both runs
    must give `go.seen`; `R` still counts cases, not runs. r09 and r10 catch an
    implementation that reads only the `RawPath` field (`net/url` leaves it
    empty there); r24 catches one that reads only `EscapedPath()` (the `|`
    makes it re-escape the decoded path and lose the `%2F`).
  - **ts** passes `target` as `req.url` (and `req.path` without the query for
    the scope adapter) and asserts `ts.seen`.
  - **java** builds a `FakeReq` from the `java` triple (`request_uri`,
    `servlet_path`, `path_info`; `null` means `getPathInfo()` returns null) and
    asserts `java_expect.seen`. `"400"` means the filter answers
    `400 invalid_path` and never consults a rule. The triple is an INPUT: it
    stands for what a container hands over, so container differences are not
    under test.
  - In every language, also assert that the first rule of `request_rules.mfa`
    matching `seen` is `mfa_rule` (`null` = none, and always `null` for `400`).
- `matcher_case_count` / `request_case_count`: how many cases the file holds.

## How a runner reports (MUST)

A runner prints ONE line, after it has run every case:

```
path-match-vectors <lang>: ran <M> matcher + <R> request cases, <F> failed
```

and FAILS (non-zero, a test failure, not a skip) when:

1. it ran zero cases in either section; or
2. `M` differs from `matcher_case_count` or `R` from `request_case_count`
   (a filter, a parse error or a silently skipped case is a partial run); or
3. any case failed.

A runner never skips a case for its language: if a case looks wrong for your
language, that is a SPEC question, raised before the code changes.

## Where the runners live

One per language, reading this file by a path relative to the repo root (it
sits OUTSIDE `go/` on purpose: a file inside the Go module ships in the module
zip and changes its hash). The Go runner reads it with `os.ReadFile` from
`../testdata/...`; never copy it into `go/`.
