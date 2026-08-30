/**
 * The GoFr envelope primitives, plus the PARITY GATE against `@realm-id/sdk`.
 *
 * `@realm-id/web` ships with ZERO runtime dependencies on purpose, so it cannot
 * import `@realm-id/sdk`'s copy at runtime. That leaves exactly one honest
 * option: an identical implementation with a test that compares the two on the
 * same fixture table and fails when they diverge. A hand-maintained copy with
 * no drift test is the failure mode this refactor exists to delete.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { unwrapData, parseErrorEnvelope } from "./envelope.js";
import {
  unwrapData as sdkUnwrapData,
  parseErrorEnvelope as sdkParseErrorEnvelope,
} from "@realm-id/sdk";

/** Every shape either function has to survive. Shared by BOTH halves below. */
const BODIES: unknown[] = [
  undefined,
  null,
  "",
  "plain text",
  0,
  [],
  [{ data: 1 }],
  {},
  { data: { id: "t1" } },
  { data: undefined },
  { data: null },
  { data: [1, 2, 3] },
  { data: { data: "nested" } },
  { id: "t1" },
  { error: { code: "owner_cannot_leave", message: "you own this" } },
  { error: { code: "mfa_required", message: "step up" }, mfa_challenge_token: "CHAL", methods: ["totp"] },
  { error: { code: "session_limit_reached", message: "too many" }, revocation_token: "REV" },
  { error: "Unauthenticated" },
  { error: "boom", code: "flat_code" },
  { code: "top_level", message: "with siblings", extra: 1 },
  // The shapes the ISSUER actually emits. GoFr merges every key an error's
  // `Response()` map adds into ONE object and renders it under `error`
  // (`gofr.dev/pkg/gofr/http/responder.go`), so a gate payload is NESTED, not
  // beside it. The table carried only the beside-it form until 2026-08-30,
  // which is why the parity gate stayed green through two real divergences: a
  // fixture table is a hand-maintained subject list, and this one was a
  // release behind.
  {
    error: {
      code: "mfa_required",
      message: "this operation requires a fresh MFA proof",
      mfa_challenge_token: "chal-xyz",
      methods: ["totp"],
      reason: "stale_mfa",
      max_age_seconds: 300,
    },
  },
  {
    error: {
      code: "session_limit_reached",
      message: "concurrent session limit reached",
      revocation_token: "REV",
      active_sessions: [{ id: "j1" }],
    },
  },
  // Both levels populated, same key on each: pins WHICH one wins.
  { error: { code: "mfa_required", message: "m", mfa_challenge_token: "inner" }, mfa_challenge_token: "outer" },
  // The legacy nested form with no `message` key at all.
  { error: { code: "forbidden", error: "not the tenant owner" } },
  // Flat, with siblings beside the code.
  { error: "concurrent session limit reached", code: "session_limit_reached", revocation_token: "REV" },
  { error: {} },
  { error: [] },
  { error: { code: 7, message: 9 } },
];

const STATUSES = [400, 401, 403, 409, 412, 500, 502];

// ---- unwrapData ----

test("unwrapData strips exactly one envelope and only when `data` holds something", () => {
  assert.deepEqual(unwrapData({ data: { id: "t1" } }), { id: "t1" });
  assert.deepEqual(unwrapData({ data: { data: "nested" } }), { data: "nested" });
  assert.deepEqual(unwrapData({ id: "t1" }), { id: "t1" });
  assert.deepEqual(unwrapData({ data: undefined }), { data: undefined });
  assert.equal(unwrapData({ data: null }), null);
});

test("unwrapData unwraps a `data` key even alongside siblings", () => {
  // `unwrapEnvelope` in transport.ts requires `data` to be the SOLE key; this
  // one deliberately does not, matching the sdk. The two are different
  // functions with different rules — do not collapse them.
  assert.deepEqual(unwrapData({ data: { id: "x" }, next_cursor: "c" }), { id: "x" });
});

// ---- parseErrorEnvelope ----

test("parseErrorEnvelope reads the coded nested shape and keeps the gate payload", () => {
  const got = parseErrorEnvelope(
    { error: { code: "mfa_required", message: "step up" }, mfa_challenge_token: "CHAL" },
    412,
  );
  assert.equal(got.code, "mfa_required");
  assert.equal(got.message, "step up");
  assert.deepEqual(got.details, { mfa_challenge_token: "CHAL" });
});

test("parseErrorEnvelope survives the CODE-LESS GoFr middleware 401", () => {
  const got = parseErrorEnvelope({ error: "Unauthenticated" }, 401);
  assert.equal(got.code, undefined, "there is no code to branch on, ever");
  assert.equal(got.message, "Unauthenticated");
});

test("parseErrorEnvelope reads the flat shape and the top-level shape", () => {
  assert.equal(parseErrorEnvelope({ error: "boom", code: "flat" }, 400).code, "flat");
  const top = parseErrorEnvelope({ code: "top", message: "m", extra: 1 }, 400);
  assert.equal(top.code, "top");
  assert.deepEqual(top.details, { extra: 1 });
});

test("parseErrorEnvelope never guesses on an unrecognisable body", () => {
  assert.deepEqual(parseErrorEnvelope("<html>502</html>", 502), { message: "HTTP 502" });
  assert.deepEqual(parseErrorEnvelope(undefined, 500), { message: "HTTP 500" });
  assert.deepEqual(parseErrorEnvelope([], 400), { message: "HTTP 400" });
});

// ---- the parity gate ----

test("PARITY: unwrapData matches @realm-id/sdk on every fixture", () => {
  for (const b of BODIES) {
    assert.deepEqual(
      unwrapData(b),
      sdkUnwrapData(b),
      `unwrapData drifted from @realm-id/sdk on ${JSON.stringify(b)}`,
    );
  }
});

test("PARITY: parseErrorEnvelope matches @realm-id/sdk on every fixture × status", () => {
  let compared = 0;
  for (const b of BODIES) {
    for (const s of STATUSES) {
      assert.deepEqual(
        parseErrorEnvelope(b, s),
        sdkParseErrorEnvelope(b, s),
        `parseErrorEnvelope drifted from @realm-id/sdk on ${JSON.stringify(b)} @ ${s}`,
      );
      compared += 1;
    }
  }
  // Refuse to pass vacuously: an empty fixture table would otherwise be green.
  assert.ok(compared >= BODIES.length * STATUSES.length && compared > 100, `only ${compared} comparisons`);
});
