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
