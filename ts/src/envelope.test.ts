import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseErrorEnvelope, unwrapData } from "./envelope.js";

// The GoFr envelope seam. `reference_issuer_error_envelope_shapes` records this
// as a recurring bug source: a bad `Authorization` bearer is rejected by GoFr's
// own middleware and answers a CODE-LESS 401, while a handler refusal answers
// the coded `{error:{code,message}}` shape. A retry guard that matches only one
// of them is a guard that fires on the wrong half.

test("unwrapData strips exactly one { data } envelope", () => {
  assert.deepEqual(unwrapData<{ id: string }>({ data: { id: "t1" } }), { id: "t1" });
  assert.deepEqual(unwrapData<{ data: number }>({ data: { data: 1 } }), { data: 1 });
});

test("unwrapData passes through a body with no data key", () => {
  assert.deepEqual(unwrapData<{ id: string }>({ id: "t1" }), { id: "t1" });
  assert.deepEqual(unwrapData<string[]>(["a"]), ["a"]);
  assert.equal(unwrapData<undefined>(undefined), undefined);
  assert.equal(unwrapData<string>("plain"), "plain");
});

test("unwrapData keeps a body whose data key is explicitly undefined", () => {
  // `{data: undefined}` is not an envelope around nothing — unwrapping it would
  // turn a real payload key into a silent loss.
  assert.deepEqual(unwrapData<{ data: undefined; id: string }>({ data: undefined, id: "t1" }), {
    data: undefined,
    id: "t1",
  });
});

test("unwrapData does not unwrap a null data envelope into undefined", () => {
  assert.equal(unwrapData<null>({ data: null }), null);
});

test("parseErrorEnvelope: the coded nested shape, with siblings", () => {
  const got = parseErrorEnvelope(
    { error: { code: "mfa_required", message: "step-up required" }, mfa_challenge_token: "ch_1" },
    412,
  );
  assert.equal(got.code, "mfa_required");
  assert.equal(got.message, "step-up required");
  assert.deepEqual(got.details, { mfa_challenge_token: "ch_1" });
});

test("parseErrorEnvelope: the CODE-LESS GoFr middleware 401", () => {
  const got = parseErrorEnvelope({ error: "Unauthenticated" }, 401);
  assert.equal(got.code, undefined);
  assert.equal(got.message, "Unauthenticated");
  assert.equal(got.details, undefined);
});

test("parseErrorEnvelope: the flat shape carries code beside the message", () => {
  const got = parseErrorEnvelope(
    { error: "contact an administrator", code: "contact_admin_required" },
    409,
  );
  assert.equal(got.code, "contact_admin_required");
  assert.equal(got.message, "contact an administrator");
});

test("parseErrorEnvelope: a top-level { code, message, ...siblings } body", () => {
  const got = parseErrorEnvelope(
    { code: "session_limit_reached", message: "too many sessions", revocation_token: "rv_1" },
    412,
  );
  assert.equal(got.code, "session_limit_reached");
  assert.equal(got.message, "too many sessions");
  assert.deepEqual(got.details, { revocation_token: "rv_1" });
});

test("parseErrorEnvelope: a non-object body yields a status-shaped message", () => {
  assert.deepEqual(parseErrorEnvelope(undefined, 502), { message: "HTTP 502" });
  assert.deepEqual(parseErrorEnvelope("<html>bad gateway</html>", 502), { message: "HTTP 502" });
  assert.deepEqual(parseErrorEnvelope(null, 500), { message: "HTTP 500" });
});

test("parseErrorEnvelope: an empty message is not adopted over the fallback", () => {
  const got = parseErrorEnvelope({ error: { code: "forbidden", message: "" } }, 403);
  assert.equal(got.code, "forbidden");
  assert.equal(got.message, "HTTP 403");
});

test("parseErrorEnvelope: the raw server code is preserved even when unknown", () => {
  // `role_owner_only` (ADR-101 D6) is not in the SDK's ErrorCode union. The
  // parser reports what the server SAID; mapping it into the union is the
  // caller's job, and losing it here is how a specific remedy becomes a
  // generic 403.
  const got = parseErrorEnvelope({ error: { code: "role_owner_only", message: "owner only" } }, 403);
  assert.equal(got.code, "role_owner_only");
});

test("parseErrorEnvelope: a nested legacy `error` string is the message", () => {
  // Some issuer refusals render `{"error":{"code":…,"error":"<msg>"}}` with no
  // `message` key at all. The nested branch read only `message`, so the text was
  // lost entirely — `siblings(obj, …)` walks the TOP level, never the nested
  // object's keys — and the caller saw the bare status fallback. The flat branch
  // has always done this fallback; the asymmetry was the bug.
  const got = parseErrorEnvelope({ error: { code: "forbidden", error: "not the tenant owner" } }, 403);
  assert.equal(got.message, "not the tenant owner");
  assert.equal(got.code, "forbidden");
});

test("parseErrorEnvelope: an explicit nested `message` still outranks the legacy string", () => {
  const got = parseErrorEnvelope(
    { error: { code: "forbidden", error: "legacy", message: "explicit" } },
    403,
  );
  assert.equal(got.message, "explicit");
});

// ---- nested gate payloads (2026-08-30) ----
//
// This is the shape the ISSUER actually emits, and it is why this is a defect
// and not a hypothetical. GoFr's `createErrorResponse` merges every key an
// error's `Response()` map adds into ONE object and renders it under the
// top-level `error` field (`gofr.dev/pkg/gofr/http/responder.go`), so
// `mfaGateError.Response()`'s `mfa_challenge_token` / `methods` /
// `max_age_seconds` and `sessionLimitErr.Response()`'s `revocation_token` /
// `active_sessions` all arrive INSIDE the error object. `siblings(obj, …)`
// walks only the TOP level, so a TS caller driving a step-up gate got an empty
// details map — a challenge with no token to answer it. Go collected both.

test("parseErrorEnvelope: nested gate payload survives (the issuer's real 412)", () => {
  const got = parseErrorEnvelope(
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
    412,
  );
  assert.equal(got.code, "mfa_required");
  assert.deepEqual(got.details, {
    mfa_challenge_token: "chal-xyz",
    methods: ["totp"],
    reason: "stale_mfa",
    max_age_seconds: 300,
  });
});

test("parseErrorEnvelope: nested revocation_token + active_sessions survive", () => {
  const got = parseErrorEnvelope(
    {
      error: {
        code: "session_limit_reached",
        message: "concurrent session limit reached",
        revocation_token: "tok-abc",
        active_sessions: [{ id: "j1" }],
      },
    },
    412,
  );
  assert.equal(got.details?.["revocation_token"], "tok-abc");
  assert.deepEqual(got.details?.["active_sessions"], [{ id: "j1" }]);
});

test("parseErrorEnvelope: nested and top-level siblings are both collected", () => {
  // The BFF's own step-up envelope (`writeStepUpChallenge`) puts the challenge
  // BESIDE `error`; the issuer puts it inside. One parser reads both, so a
  // client that handles one handles the other.
  const got = parseErrorEnvelope(
    { error: { code: "mfa_required", message: "m", reason: "stale_mfa" }, mfa_challenge_token: "beside" },
    412,
  );
  assert.equal(got.details?.["mfa_challenge_token"], "beside");
  assert.equal(got.details?.["reason"], "stale_mfa");
});

test("parseErrorEnvelope: a nested sibling outranks a top-level one of the same name", () => {
  // Matches the Go collection order (top level first, nested overwrites), so a
  // body carrying both does not resolve differently per language.
  const got = parseErrorEnvelope(
    { error: { code: "mfa_required", message: "m", mfa_challenge_token: "inner" }, mfa_challenge_token: "outer" },
    412,
  );
  assert.equal(got.details?.["mfa_challenge_token"], "inner");
});

test("parseErrorEnvelope: the nested envelope's own code/message/error are not details", () => {
  const got = parseErrorEnvelope(
    { error: { code: "forbidden", message: "m", error: "legacy" } },
    403,
  );
  assert.equal(got.details, undefined);
});

test("parseErrorEnvelope: the flat shape collects its siblings too", () => {
  // `{"error":"<msg>","code":"…", …}` — Go's flat branch has always collected
  // the siblings beside it; TS dropped them, so the two SDKs disagreed on a
  // second shape as well as the nested one.
  const got = parseErrorEnvelope(
    { error: "concurrent session limit reached", code: "session_limit_reached", revocation_token: "tok-abc" },
    412,
  );
  assert.equal(got.code, "session_limit_reached");
  assert.equal(got.details?.["revocation_token"], "tok-abc");
});
