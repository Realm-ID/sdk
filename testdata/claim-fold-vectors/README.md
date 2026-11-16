# Claim-fold vectors (normative)

The shared cases for the reserved-claim fold rule: `sdk/SPEC.md` §4.2, anchor
`SPEC4_2_claim_fold`. Decided 2026-11-14 for audit finding e-02; why in
`sdk/DECISIONS.md` 2026-11-14. The ISSUER runs BOTH sections: the `keys`
section at the allowlist write AND at the mint (issuer ADR-097 AF-097.3), and
the `payloads` section in its own token decode, which refuses every
fold-colliding pair of keys, not only a pair that folds to a reserved claim
(AF-097.4). Its runner reads this file from the sibling `sdk/` checkout or a
vendored copy that a test pins byte-for-byte to this one.

## The rule, in one paragraph

`fold(k)` maps ASCII `A`-`Z` to `a`-`z` and nothing else. A custom-claim key is
accepted only when it is non-empty, every character is printable ASCII
(`%x20-7E`), and its fold differs from the fold of every reserved name. A token
is refused when, among its TOP-LEVEL payload keys taken after JSON unescaping,
any key fails the charset, any two keys fold to the same string (exact
duplicates included), or a key that is not byte-equal to a reserved name folds
to one. The fold is ASCII-only BECAUSE the charset rule runs first: every key
that survives is ASCII, and on ASCII text ASCII folding and Unicode simple
folding are the same relation, so no decoder (Go `encoding/json` folds with
`unicode.SimpleFold`) can bind a key the check did not see.

## Format (`vectors.json`)

- `reserved`: the reserved set of issuer `v0.151.0`: `issuer/internal/tokens/tokens.go`
  `reservedClaims` plus `acr` (owner ruling 8, 2026-11-14; the issuer gains it
  in unit I4). A runner MUST first assert
  that its language's reserved set equals this list exactly (a drift test).
- `keys[]`: `{id, key, expect}`, `expect` one of `accept`, `refuse_reserved`,
  `refuse_charset`. Drives the SDK's pre-check of `customClaims` handler output
  (SPEC §10.2) and the issuer's allowlist write and mint.
- `payloads[]`: `{id, payload_json, expect}`, `expect` `accept` or `refuse`.
  `payload_json` is RAW JSON TEXT: duplicate keys cannot exist in a parsed
  object, so the runner MUST extract top-level keys with a duplicate-preserving
  tokenizer (Go `json.Decoder.Token`, a streaming parser in ts and java), never
  by decoding into a map first. An SDK's `refuse` surfaces from `verify()` as
  `malformed` (401); a runner MUST also drive at least one `refuse` case per
  reason through a SIGNED token end to end, so the check is proven to be wired
  into `verify()` and not only present as a function.
- `key_case_count` / `payload_case_count`: how many cases the file holds.

## How a runner reports (MUST)

A runner prints ONE line, after it has run every case:

```
claim-fold-vectors <lang>: ran <K> key + <P> payload cases, <F> failed
```

and FAILS (a test failure, not a skip) when it ran zero cases in either
section, when `K` or `P` differs from the declared count, when the reserved-set
drift check fails, or when any case failed. A case is never skipped per language.

The file sits outside `go/` on purpose (a file in the Go module changes its
hash); the Go runner reads `../testdata/claim-fold-vectors/vectors.json`.
