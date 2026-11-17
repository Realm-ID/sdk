# Role-predicate vectors (normative)

Shared cases for the role predicates every SDK ships: `sdk/SPEC.md` §6.3,
"Role predicates — one vector file". The issuer is authoritative; these cases
are its answers, and the go, ts and java predicates MUST give exactly them.
When a language disagrees with a case, the language is wrong, and a case
changes only with a SPEC change in the same commit.

## Format (`vectors.json`)

- `catalogs`: named permission catalogs (`{key, action}` rows, the shape of
  `ListPermissions`). A `confers` case names one, or gives `[]` or `null`.
- `confers[]`: `{id, permissions, catalog, confers, why}`.
  - `catalog: null` calls the PARSE form: go `ConfersAuthority(perms)`, ts
    `confersAuthority({ permissions })`, java
    `RolePredicates.confersAuthority(perms)`.
  - `catalog: []` or a name calls the CATALOG form: go
    `ConfersAuthorityWithCatalog(perms, catalog)`, ts
    `confersAuthority({ permissions }, { catalog })`, java
    `RolePredicates.confersAuthority(perms, catalog)`.
  - Assert `confers`.
- `assignable[]`: `{id, role, kind, assignable, why}`. `role` uses the wire
  field names (`name`, `disabled`, `is_system`, `assignable_to`, `permissions`);
  an absent field takes its zero value (`assignable_to` absent = null). Call go
  `IsRoleAssignableTo(role, kind)`, ts `isRoleSeatable(role, kind)`, java
  `RolePredicates.isRoleAssignableTo(role, kind)`; assert `assignable`. These
  three carry the same guards (a system-unassignable name, a disabled role, the
  declared kinds, the human-only floor). ts's own `isRoleAssignableTo` leaves
  the name and disabled guards to `isRoleSeatable`, so it is not the function
  under test. In ts, a kind outside `PrincipalKind` (`"bot"`) is passed through
  a cast.
- `confers_case_count` / `assignable_case_count`: how many cases each section holds.

## The three rules these cases pin

1. **Strings are used as given.** No language trims or rewrites a permission
   string; `" users:read "` and `"   "` confer (rp07, rp08), as the issuer says.
2. **An empty catalog gives the parse-form answer** (rp09, rp10). A non-empty
   catalog decides by key, and a key absent from it confers (rp12).
3. **An empty or absent `assignable_to` admits any kind** (ra04-ra06, ra08), an
   unlisted kind such as `"bot"` included, as the issuer's
   `realmrole.AssignableToKind` answers. A non-empty list admits only the kinds
   it names (ra03, ra07).

## How a runner reports (MUST)

One line, after every case has run:

```
role-predicate-vectors <lang>: ran <C> confers + <A> assignable cases, <F> failed
```

and FAIL (a test failure, not a skip) when either section ran zero cases, when
`C` or `A` differs from its `*_case_count`, or when any case failed. A runner
never skips a case for its language.

## Which test consumes it

Each language's drift test MUST run every case in this file, reading it by a
path relative to the repo root (this file sits OUTSIDE `go/` on
purpose: a file inside the Go module changes the module hash; never copy it
into `go/`):

| Language | Test that must run it |
|---|---|
| go | `go/roles_drift_test.go` (reads `../testdata/role-predicate-vectors/vectors.json`) |
| ts | `ts/src/roles-drift.test.ts` |
| java | `java/src/test/java/dev/realmid/sdk/roles/RolePredicateVectorsTest.java` |
