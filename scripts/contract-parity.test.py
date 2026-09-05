#!/usr/bin/env python3
"""Tests for contract-parity.py — run BEFORE it in `make self-test`, per the
checker-tests rule (`sdk/scripts/release-check.test.sh`'s own header cites the
same precedent): `scripts/todo-ranking-hygiene.py` shipped with a defect that
read "file absent" as "item closed" and turned pushes green on a finding that
had not happened. A new verdict-rendering script must fail as a broken
checker, never silently pass as a clean one.

Every fixture here is a THROWAWAY tree under a temp dir — never this repo's
real `issuer/docs/swagger.yaml` or `ts/`/`go/`/`java/` sources, so a test
failure can never be confused with a real contract finding, and a real finding
can never be masked as "just the test fixture".

The single most important case is the NEGATIVE one: `test_catches_planted_role_id_drift`
reproduces the exact ADR-101 D7 shape (spec requires `permissions`, an SDK
still sends `role_id`) and asserts the checker's `report()` returns drift=True
with that specific field named. A checker that always says "PARITY" is a
scarier bug than the drift it exists to catch, per this repo's own precedent
above.

Usage: python3 scripts/contract-parity.test.py
Exit 0 = every assertion passed, 1 = a test failed.
"""
import importlib.util
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))

FAILED = 0
PASS = 0


def assert_true(desc, cond):
    global FAILED, PASS
    if cond:
        PASS += 1
    else:
        print(f"FAIL: {desc}")
        FAILED = 1


def assert_eq(desc, want, got):
    assert_true(f"{desc} — want {want!r} got {got!r}", want == got)


def load_module():
    """`contract-parity.py` has a hyphen, so it is invoked as a script, never
    `import`ed by name — load it the same way `python3 -m` cannot."""
    spec = importlib.util.spec_from_file_location(
        "contract_parity", os.path.join(HERE, "contract-parity.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


SPEC_FIXTURE = """\
openapi: 3.0.3
paths:
  /widgets:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, permissions]
              properties:
                name: { type: string }
                permissions:
                  type: array
                  items: { type: string }
                color: { type: string }
  /widgets/refs:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/WidgetCreate' }
  /widgets/list:
    get:
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: { $ref: '#/components/schemas/WidgetListPage' }
components:
  schemas:
    WidgetCreate:
      type: object
      required: [name]
      properties:
        name: { type: string }
        tag: { type: string }
    WidgetListPage:
      type: object
      properties:
        items:
          type: array
          items: { type: string }
        next_cursor: { type: string, nullable: true }
"""


def main():
    mod = load_module()
    work = tempfile.mkdtemp(prefix="contract-parity-test-")
    try:
        run_generic_parser_tests(mod, work)
        run_die_on_missing_spec_test(mod, work)
        run_positive_and_negative_contract_tests(mod, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print()
    print(f"{PASS} assertion(s) passed.")
    if FAILED:
        print("contract-parity.test.py: FAILED")
        return 1
    print("contract-parity.test.py: PASS")
    return 0


def run_generic_parser_tests(mod, work):
    """The swagger.yaml-lite reader, exercised against a small fixture spec —
    never against issuer/docs/swagger.yaml, so a real drift can't sneak in
    disguised as a test result and a fixture bug can't be reported as a real
    finding."""
    spec_path = os.path.join(work, "swagger.yaml")
    write(spec_path, SPEC_FIXTURE)
    lines = open(spec_path, encoding="utf-8").read().splitlines()

    required, props = mod.request_body_fields(lines, "/widgets", "post")
    assert_eq("inline requestBody: required", ["name", "permissions"], required)
    assert_eq("inline requestBody: properties", ["name", "permissions", "color"], props)

    required, props = mod.request_body_fields(lines, "/widgets/refs", "post")
    assert_eq("$ref requestBody: required", ["name"], required)
    assert_eq("$ref requestBody: properties", ["name", "tag"], props)

    props = mod.response_200_fields(lines, "/widgets/list", "get")
    assert_eq("$ref response schema: properties", ["items", "next_cursor"], props)

    # A path/method/schema that does not exist must DIE (exit 2), never
    # return an empty/successful result — that is the "cannot see" vs
    # "saw nothing wrong" distinction this whole module exists to preserve.
    rc = _expect_exit(lambda: mod.request_body_fields(lines, "/does-not-exist", "post"))
    assert_eq("unknown path dies with exit 2", 2, rc)
    rc = _expect_exit(lambda: mod.request_body_fields(lines, "/widgets", "delete"))
    assert_eq("unknown method dies with exit 2", 2, rc)
    rc = _expect_exit(lambda: mod.schema_fields(lines, "NoSuchSchema"))
    assert_eq("unknown $ref target dies with exit 2", 2, rc)


def _expect_exit(fn):
    try:
        fn()
    except SystemExit as e:
        return e.code
    return None


def run_die_on_missing_spec_test(mod, work):
    """The single most load-bearing property per the brief: a MISSING spec
    must fail loudly, never silently pass."""
    missing = os.path.join(work, "does", "not", "exist.yaml")
    rc = _expect_exit(lambda: mod.read(missing, "test spec"))
    assert_eq("missing spec file dies with exit 2 (never a silent pass)", 2, rc)


TS_FIXTURE = """\
export class WidgetsClient {
  async create(body: WidgetCreate): Promise<Widget> {
    return this.http.request<Widget>({
      method: "POST",
      path: this.base(),
      body: { name: body.name, permissions: body.permissions },
    });
  }
}
"""

TS_FIXTURE_DRIFTED = """\
export class WidgetsClient {
  async create(body: WidgetCreate): Promise<Widget> {
    return this.http.request<Widget>({
      method: "POST",
      path: this.base(),
      body: { name: body.name, role_id: body.roleId },
    });
  }
}
"""

GO_FIXTURE = """\
package widgets

type WidgetCreate struct {
\tName        string   `json:"name"`
\tPermissions []string `json:"permissions,omitempty"`
}
"""

JAVA_FIXTURE = """\
public final class WidgetsClient {
    public Widget create(WidgetCreate body) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("name", body.name());
        b.put("permissions", body.permissions());
        return http.request(...);
    }
}
"""


def run_positive_and_negative_contract_tests(mod, work):
    """Builds a throwaway sdk tree (ts/go/java) plus a spec requiring
    `name`+`permissions`, then proves `report()`:
      1. reports PARITY when every language matches (positive control — a
         checker that always reports drift is as useless as one that never
         does), and
      2. reports DRIFT, naming the exact stray field, when one language sends
         the retired `role_id` instead of `permissions` — the ADR-101 D7 shape
         this whole gate exists for.
    """
    spec_path = os.path.join(work, "issuer", "docs", "swagger.yaml")
    write(spec_path, SPEC_FIXTURE)
    write(os.path.join(work, "sdk", "ts", "src", "widgets.ts"), TS_FIXTURE)
    write(os.path.join(work, "sdk", "go", "widgets.go"), GO_FIXTURE)
    write(os.path.join(work, "sdk", "java", "WidgetsClient.java"), JAVA_FIXTURE)

    contract = {
        "name": "widgets.create — POST /widgets",
        "kind": "request",
        "path": "/widgets",
        "method": "post",
        "sdk": {
            "ts": lambda: mod.ts_request_wire_keys(
                "ts/src/widgets.ts", "async create(body: WidgetCreate)"),
            "go": lambda: mod.go_struct_json_tags("go/widgets.go", "WidgetCreate"),
            "java": lambda: mod.java_put_keys(
                "java/WidgetsClient.java", "Widget create(WidgetCreate body)"),
        },
    }

    orig_repo_root, orig_spec_path, orig_contracts, orig_extra_ok = (
        mod.REPO_ROOT, mod.SPEC_PATH, mod.CONTRACTS, mod.EXTRA_OK)
    try:
        mod.REPO_ROOT = os.path.join(work, "sdk")
        mod.SPEC_PATH = spec_path
        mod.CONTRACTS = [contract]
        mod.EXTRA_OK = {}

        drift = mod.report()
        assert_eq("positive control: matching fixtures report no drift", False, drift)

        # Now plant the exact defect class: swap the TS fixture to send the
        # retired `role_id` instead of `permissions`.
        write(os.path.join(work, "sdk", "ts", "src", "widgets.ts"), TS_FIXTURE_DRIFTED)
        drift = mod.report()
        assert_eq("negative control: planted role_id drift IS detected", True, drift)
    finally:
        mod.REPO_ROOT, mod.SPEC_PATH, mod.CONTRACTS, mod.EXTRA_OK = (
            orig_repo_root, orig_spec_path, orig_contracts, orig_extra_ok)


if __name__ == "__main__":
    sys.exit(main())
