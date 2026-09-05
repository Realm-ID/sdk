#!/usr/bin/env python3
"""SDK↔server contract drift gate — request/response field names and
required-ness against `issuer/docs/swagger.yaml`, the workspace's authoritative
HTTP contract (see the umbrella `CLAUDE.md`: "the HTTP contract ... swagger.yaml
(authoritative)").

THE GAP THIS CLOSES. `scripts/taxonomy-parity.py` compares the three SDKs'
error-code taxonomies AGAINST EACH OTHER. That catches one SDK drifting from
its siblings; it cannot catch all three agreeing with each other and being
wrong about the server — which is exactly what happened twice, per
`tests/sdk-e2e/README.md` (the umbrella repo, not this one):

  - All three SDKs sent a retired `role_id` field on `integrations.install`
    while the issuer had required `permissions` since ADR-101 D7. Every real
    call answered 400. Invisible to unit tests: the SDK and its own fixture
    server shared the same wrong assumption, so nothing ever disagreed with
    itself.
  - TS `listSessions` decoded `{sessions: []}` while the issuer answers
    `{items, next_cursor, total}` — it returned `[]` against every real issuer
    until 0.37.0.

Both are FIELD-NAME/REQUIRED-NESS bugs, not missing-endpoint bugs, which is why
this gate parses swagger's `requestBody`/response schemas rather than just
diffing a path list.

SCOPE (deliberately narrow — see CONTRACTS below). This covers the two
endpoints the documented defects touched, plus three more simple flat-object
contracts cheap to verify correctly: role-template creation (ADR-101, the
newest write surface) and the user-api-key mint body (ADR-100, the "empty
authority field acquires a meaning nobody chose" surface). It does NOT cover
nested/oneOf bodies (`/auth/login`'s grant-type union, `RealmConfigPatch`'s
nested JSONB knob groups) — a hand-rolled indentation parser can read a flat
`required: [...]` + `properties:` block correctly; forcing it through a oneOf
or a multi-level nested object without a real YAML/JSON-Schema library would
either miss real drift or invent it, and this file's whole reason to exist is
to not do that. Widening it is `sdk/TODO.md`'s job, one contract at a time.

THE SPEC FILE LIVES IN A DIFFERENT REPO (`issuer/`, a sibling checkout next to
this one — `../../issuer/docs/swagger.yaml` from here). **A missing spec FAILS
LOUDLY** (exit 2), never a silent pass — this workspace has repeatedly shipped
a gate that went green by not running (`sdk/TODO.md`'s guards-that-report-
nothing lesson; `todo-ranking-hygiene.py`'s "closure that had not happened").
There is also a served copy at `GET /.well-known/openapi.json`, but this
script is offline by contract (see `preflight-check.sh`'s header), so the
checked-out file is the source of truth, not the live endpoint.

WHY A HAND-ROLLED YAML READER, NOT PyYAML. Matching `taxonomy-parity.py`'s own
shape: stdlib only, no new dependency, regex/indentation extraction anchored on
the exact text that would break if the shape changed (`MIN_CODES` there,
`_require_lines`-driven counts here). `sdk/scripts/*.py` has never taken a pip
dependency and CI's `taxonomy` job installs nothing before running it.

Exit 0 = every contract's fields match, 1 = drift, 2 = parse/usage error
(includes: spec file absent, an anchor this script depends on not found in the
spec, or a language's own extraction anchor not found in its source — all
three are "the checker cannot see", never "the checker saw nothing wrong").
"""
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Nested-repo layout, per the umbrella CLAUDE.md ("Realm-ID/project" contains
# issuer/, api/, sdk/, ... as sibling checkouts) — never assume a vendored copy.
SPEC_PATH = os.path.normpath(os.path.join(REPO_ROOT, "..", "issuer", "docs", "swagger.yaml"))


def die(msg, code=2):
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(code)


def read(path, what):
    if not os.path.exists(path):
        die(f"{what} not found at {path} — this gate cannot run without it "
            f"(a missing spec is a FAILURE, never a pass)")
    return open(path, encoding="utf-8").read()


# ── minimal indentation-based YAML reading ──────────────────────────────────
#
# Not a YAML parser: it locates one header line by regex, then treats every
# subsequent line whose indentation is GREATER than the header's as "inside"
# it, stopping at the first non-blank, non-comment line that is not. That is
# enough to pull `required: [...]` and direct `properties:` children out of
# swagger.yaml's block style without a library, and it works at any absolute
# indent because it is always relative to the header it was handed.

def _indent(line):
    return len(line) - len(line.lstrip(" "))


def _block_end(lines, header_idx):
    """Index of the first line at or below header_idx's indent (blank/comment
    lines don't count), i.e. the exclusive end of header_idx's nested block."""
    base = _indent(lines[header_idx])
    j = header_idx + 1
    while j < len(lines):
        line = lines[j]
        stripped = line.strip()
        if stripped == "" or stripped.startswith("#"):
            j += 1
            continue
        if _indent(line) <= base:
            break
        j += 1
    return j


def _find(lines, pattern, start, end):
    rx = re.compile(pattern)
    for i in range(start, end):
        if rx.match(lines[i]):
            return i
    return None


def _direct_properties(lines, properties_idx, end):
    """Direct (one-level-deeper) child keys under a `properties:` line."""
    base = _indent(lines[properties_idx]) + 2
    out = []
    for i in range(properties_idx + 1, end):
        m = re.match(rf"^ {{{base}}}([A-Za-z_][A-Za-z0-9_]*):", lines[i])
        if m:
            out.append(m.group(1))
    return out


def _required_list(lines, start, end):
    for i in range(start, end):
        m = re.search(r"required:\s*\[([^\]]*)\]", lines[i])
        if m:
            return [x.strip().strip("'\"") for x in m.group(1).split(",") if x.strip()]
    return []


def schema_fields(lines, schema_name):
    """required[] + properties[] of a `components/schemas` entry by name."""
    idx = _find(lines, rf"^    {re.escape(schema_name)}:\s*$", 0, len(lines))
    if idx is None:
        die(f"components/schemas/{schema_name} not found in swagger.yaml — "
            f"a contract's $ref target moved or was renamed")
    end = _block_end(lines, idx)
    required = _required_list(lines, idx, end)
    pidx = _find(lines, r"^\s*properties:\s*$", idx, end)
    properties = _direct_properties(lines, pidx, end) if pidx is not None else []
    return required, properties


def request_body_fields(lines, path, method):
    """required[] + properties[] of one operation's requestBody schema,
    inline or via a `$ref: '#/components/schemas/Name'`."""
    pidx = _find(lines, rf"^  {re.escape(path)}:\s*$", 0, len(lines))
    if pidx is None:
        die(f"{path} not found in swagger.yaml — the endpoint moved or was renamed")
    pend = _block_end(lines, pidx)
    midx = _find(lines, rf"^    {re.escape(method)}:\s*$", pidx, pend)
    if midx is None:
        die(f"{method.upper()} {path} not found in swagger.yaml")
    mend = _block_end(lines, midx)
    ridx = _find(lines, r"^\s*requestBody:\s*$", midx, mend)
    if ridx is None:
        die(f"{method.upper()} {path} has no requestBody in swagger.yaml")
    rend = _block_end(lines, ridx)
    for i in range(ridx, rend):
        m = re.search(r"\$ref:\s*'#/components/schemas/(\w+)'", lines[i])
        if m:
            return schema_fields(lines, m.group(1))
    required = _required_list(lines, ridx, rend)
    pidx2 = _find(lines, r"^\s*properties:\s*$", ridx, rend)
    properties = _direct_properties(lines, pidx2, rend) if pidx2 is not None else []
    return required, properties


def response_200_fields(lines, path, method):
    """properties[] of one operation's 200 response schema (inline or $ref)."""
    pidx = _find(lines, rf"^  {re.escape(path)}:\s*$", 0, len(lines))
    if pidx is None:
        die(f"{path} not found in swagger.yaml")
    pend = _block_end(lines, pidx)
    midx = _find(lines, rf"^    {re.escape(method)}:\s*$", pidx, pend)
    if midx is None:
        die(f"{method.upper()} {path} not found in swagger.yaml")
    mend = _block_end(lines, midx)
    rsidx = _find(lines, r"^\s*responses:\s*$", midx, mend)
    if rsidx is None:
        die(f"{method.upper()} {path} declares no responses in swagger.yaml")
    rsend = _block_end(lines, rsidx)
    oidx = _find(lines, r"^\s*'200':\s*$", rsidx, rsend)
    if oidx is None:
        die(f"{method.upper()} {path} declares no 200 response in swagger.yaml")
    oend = _block_end(lines, oidx)
    for i in range(oidx, oend):
        m = re.search(r"\$ref:\s*'#/components/schemas/(\w+)'", lines[i])
        if m:
            return schema_fields(lines, m.group(1))[1]
    pidx2 = _find(lines, r"^\s*properties:\s*$", oidx, oend)
    return _direct_properties(lines, pidx2, oend) if pidx2 is not None else []


# ── SDK-side extraction ──────────────────────────────────────────────────────
#
# Each function is anchored on the exact source construct that puts a field
# on the wire (a `.put("wire_name", ...)` call, a `json:"wire_name"` tag, a
# wire object literal) — the same style taxonomy-parity.py uses for its own
# per-language regexes. A construct this narrow will fail LOUDLY (empty set,
# tripping the sanity check below) if the surrounding code is refactored out
# from under it, rather than silently reporting "no drift" on air.

def _read_sdk(path):
    full = os.path.join(REPO_ROOT, path)
    if not os.path.exists(full):
        die(f"{path} does not exist — run this from the sdk repo root")
    return open(full, encoding="utf-8").read()


def _slice(src, start_pat, what):
    """Text strictly between the FIRST `{` that follows `start_pat` and its
    matching `}` (brace-depth counted, not regex-guessed) — so a class method
    slice stops at its own close even though the brace is indented, and never
    bleeds into the next member the way a bare `\\n}` regex would."""
    m = re.search(start_pat, src)
    if not m:
        die(f"could not locate {what} — its anchor moved or was renamed")
    i = src.index("{", m.end())
    depth = 0
    for j in range(i, len(src)):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                return src[i + 1 : j]
    die(f"unbalanced braces reading {what}")


# Keys of the outer options object every SDK http call takes
# (`this.http.request({ method, path, query, headers, body })`) — never a wire
# field, so they are excluded from the request-key extraction below rather
# than left to coincidentally not collide with a real ADR-074 permission name.
_TRANSPORT_ENVELOPE_KEYS = {"method", "path", "query", "headers", "body"}


def ts_request_wire_keys(path, anchor):
    """Field names the method named by `anchor` (e.g. `async install(tenantId:
    string, body: InstallRequest)`) puts on the wire, covering the two shapes
    used across this repo's `*Client` methods:

      - an inline/accumulator object literal — `{ slug: ..., x: ... }` — read
        by requiring the key be the first thing after `{` or `,` (excludes a
        `const wire: Record<string, unknown> = ...` TYPE annotation, which
        looks like a colon-suffixed identifier but is preceded by a keyword,
        not `{`/`,`);
      - a later `wire["extra_field"] = ...` bracket assignment for an
        optional field, per the `if (x !== undefined) wire["k"] = x` idiom.

    The envelope keys of the outer `this.http.request({...})` call (method,
    path, query, headers, body) match the same object-literal pattern and are
    subtracted — they describe the TRANSPORT, never the request body.
    """
    src = _read_sdk(path)
    body = _slice(src, re.escape(anchor), f"{anchor} in {path}")
    # Strip `//...` line comments first: a `{`/`,` followed by a full-line
    # comment before the next field (e.g. a "why this field is unconditional"
    # note directly above `assignable_to: ...,`) otherwise breaks the "key is
    # the first thing after `{`/`,`" adjacency this function relies on.
    body = re.sub(r'//[^\n]*', '', body)
    literal_keys = set(re.findall(r'[{,]\s*([a-z][a-z0-9_]*)\s*:', body))
    bracket_keys = set(re.findall(r'\[["\']([a-z][a-z0-9_]*)["\']\]\s*=', body))
    return (literal_keys - _TRANSPORT_ENVELOPE_KEYS) | bracket_keys


def ts_interface_field_names(path, interface_name):
    """Field names declared directly in `export interface {interface_name} {
    ... }` — one `name?: Type;` per line, so a per-line anchor is enough and
    avoids the object-literal heuristics `ts_request_wire_keys` needs for
    executable code."""
    src = _read_sdk(path)
    body = _slice(src, re.escape(f"export interface {interface_name}"), f"interface {interface_name} in {path}")
    return set(re.findall(r'^\s*([a-z][a-z0-9_]*)\??\s*:', body, re.M))


def go_struct_json_tags(path, struct_name):
    src = _read_sdk(path)
    body = _slice(src, rf"type {re.escape(struct_name)} struct ", f"struct {struct_name} in {path}")
    return set(re.findall(r'json:"([a-z_]+)', body))


def java_put_keys(path, anchor):
    """Keys passed to `Map.put("name", ...)` inside the method whose
    DECLARATION line is `anchor` (e.g. `Integration register(IntegrationCreate
    body)` or `Map<String, Object> writeBody(UserAPIKeyWrite body)`).

    Deliberately the full declaration, not a bare method name: a bare name
    matches the first CALL SITE too (e.g. `.body(writeBody(body)))` inside a
    sibling method), which has no matching `{` nearby and made `_slice` walk
    into unrelated code — the exact "anchor is broken, not the contract clean"
    failure this whole module exists to surface loudly instead of silently.
    """
    src = _read_sdk(path)
    body = _slice(src, re.escape(anchor), f"{anchor} in {path}")
    return set(re.findall(r'\.put\("([a-z_]+)"', body))


# ── contracts ────────────────────────────────────────────────────────────────
#
# Each entry names one HTTP operation and, for a REQUEST, the set of field
# names each language's client puts on the wire; for a RESPONSE, the set of
# field names each language's client reads off the wire. `report()` compares
# those sets against swagger's required[]/properties[] for the same operation.

CONTRACTS = [
    {
        "name": "integrations.install — POST /tenants/{id}/integration-installations",
        "kind": "request",
        "path": "/tenants/{id}/integration-installations",
        "method": "post",
        "sdk": {
            "ts": lambda: ts_request_wire_keys("ts/src/integrations.ts", "async install(tenantId: string, body: InstallRequest)"),
            "go": lambda: go_struct_json_tags("go/integrations.go", "InstallRequest"),
            "java": lambda: java_put_keys(
                "java/src/main/java/dev/realmid/sdk/integrations/IntegrationsClient.java",
                "InstallResult install(String tenantId, InstallRequest body)"),
        },
        "note": ("THE role_id DEFECT'S ENDPOINT (ADR-101 D7). All three SDKs sent a "
                 "retired `role_id` here while the issuer required `permissions` — "
                 "every real call 400'd."),
    },
    {
        "name": "integrations.register — POST /platforms/{id}/integrations",
        "kind": "request",
        "path": "/platforms/{id}/integrations",
        "method": "post",
        "sdk": {
            "ts": lambda: ts_request_wire_keys("ts/src/integrations.ts", "async register(body: IntegrationCreate)"),
            "go": lambda: go_struct_json_tags("go/integrations.go", "IntegrationCreate"),
            "java": lambda: java_put_keys(
                "java/src/main/java/dev/realmid/sdk/integrations/IntegrationsClient.java",
                "Integration register(IntegrationCreate body)"),
        },
        "note": "cheap sibling of the install contract — same file, same pattern.",
    },
    {
        "name": "auth.listSessions — GET /auth/sessions",
        "kind": "response",
        "path": "/auth/sessions",
        "method": "get",
        "sdk": {
            "ts": lambda: ts_interface_field_names("ts/src/auth.ts", "SessionListWire"),
            "go": lambda: set(re.findall(
                r'raw\["([a-z_]+)"\]', _slice(_read_sdk("go/auth.go"),
                                               r"func decodeSessionPage\(raw map\[string\]any\)",
                                               "decodeSessionPage in go/auth.go"))),
            "java": lambda: set(re.findall(
                r'raw\.get\("([a-z_]+)"\)', _read_sdk(
                    "java/src/main/java/dev/realmid/sdk/pagination/PageReader.java"))),
        },
        "note": ("THE listSessions DEFECT. TS decoded {sessions: []}; the issuer "
                 "answers {items, next_cursor, total}. `sessions` and `has_more` "
                 "are TOLERATED legacy/optional extras, not drift — see EXTRA_OK."),
    },
    {
        "name": "roleTemplates.create — POST /platforms/{id}/role-templates",
        "kind": "request",
        "path": "/platforms/{id}/role-templates",
        "method": "post",
        "sdk": {
            "ts": lambda: ts_request_wire_keys("ts/src/role-templates.ts", "async create(body: RoleTemplateCreate)"),
            "go": lambda: go_struct_json_tags("go/roletemplates.go", "RoleTemplateCreate"),
            "java": lambda: java_put_keys(
                "java/src/main/java/dev/realmid/sdk/roles/RoleTemplatesClient.java",
                "RoleTemplateCreated create(RoleTemplateCreate body)"),
        },
        "note": "ADR-101's newest write surface (role vocabulary, base-realm only).",
    },
    {
        "name": "userApiKeys.create — POST /tenants/{tid}/users/{uid}/user-api-keys",
        "kind": "request",
        "path": "/tenants/{tid}/users/{uid}/user-api-keys",
        "method": "post",
        "sdk": {
            "ts": lambda: ts_request_wire_keys("ts/src/user-api-keys.ts", "function writeBody(body: UserApiKeyWrite)"),
            "go": lambda: go_struct_json_tags("go/user_api_keys.go", "UserAPIKeyWrite"),
            "java": lambda: java_put_keys(
                "java/src/main/java/dev/realmid/sdk/userapikeys/UserAPIKeysClient.java",
                "Map<String, Object> writeBody(UserAPIKeyWrite body)"),
        },
        "note": ("ADR-100: `uncapped` became required and an absent cap used to mean "
                 "'no restriction' — the highest-blast-radius field-shape surface in "
                 "the catalog."),
    },
]

# Fields a language is explicitly allowed to read/send BEYOND the spec's set,
# because the extra is a reviewed, documented tolerance — not drift. Anything
# NOT listed here that a language sends/reads outside the spec's fields IS
# reported as drift. Keyed by contract name.
EXTRA_OK = {
    "auth.listSessions — GET /auth/sessions": {
        "sessions",  # legacy/mock flat-array tolerance, all 3 languages
        "has_more",  # optional tri-state field, absent on older issuers
    },
}

# A FIXED floor, not `len(CONTRACTS)` — a constant computed from the thing it
# is meant to police is always true and polices nothing. Same reason
# taxonomy-parity.py's MIN_CODES is a literal, not `len(codes)`.
MIN_CONTRACTS = 5


def report():
    lines = read(SPEC_PATH, "issuer/docs/swagger.yaml").splitlines()
    drift_found = False

    print("## SDK↔swagger.yaml contract parity")
    print()
    print(f"Spec: `{os.path.relpath(SPEC_PATH, REPO_ROOT)}`")
    print(f"Contracts checked: **{len(CONTRACTS)}**")
    print()

    for c in CONTRACTS:
        if c["kind"] == "request":
            required, properties = request_body_fields(lines, c["path"], c["method"])
        else:
            required, properties = [], response_200_fields(lines, c["path"], c["method"])
        spec_fields = set(properties)
        extra_ok = EXTRA_OK.get(c["name"], set())

        sdk_fields = {}
        for lang, fn in c["sdk"].items():
            fields = fn()
            if not fields:
                die(f"{c['name']}: {lang} extractor matched zero fields — "
                    f"its anchor is broken, not the contract clean")
            sdk_fields[lang] = fields

        print(f"### {c['name']}")
        print(f"- spec required: `{sorted(required)}`")
        print(f"- spec fields: `{sorted(spec_fields)}`")
        for lang, fields in sdk_fields.items():
            print(f"- {lang} {'sends' if c['kind'] == 'request' else 'reads'}: `{sorted(fields)}`")

        problems = []
        for lang, fields in sdk_fields.items():
            missing_required = set(required) - fields
            if missing_required:
                problems.append(
                    f"{lang} does not {'send' if c['kind'] == 'request' else 'read'} "
                    f"required field(s) {sorted(missing_required)} — "
                    + ("every real call is rejected" if c["kind"] == "request"
                       else "the caller silently gets a degraded/empty read"))
            stray = fields - spec_fields - extra_ok
            if stray:
                verb = "sends" if c["kind"] == "request" else "reads"
                problems.append(f"{lang} {verb} field(s) {sorted(stray)} that are not in the spec "
                                 f"— a retired/renamed field the SDK never updated")

        if problems:
            drift_found = True
            for p in problems:
                print(f"::error::{c['name']}: {p}")
        else:
            print("PARITY.")
        print()

    return drift_found


def main():
    if len(CONTRACTS) < MIN_CONTRACTS:
        die("CONTRACTS list is empty — the parser is broken, not the contracts clean")
    drift = report()
    if drift:
        print("**CONTRACT DRIFT.** A field-name/required-ness mismatch here means real")
        print("calls fail or silently misread the server — see `issuer/docs/swagger.yaml`,")
        print("this workspace's authoritative HTTP contract.")
        return 1
    print("All checked contracts match swagger.yaml.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
