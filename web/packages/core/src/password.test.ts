/**
 * ADR-111 browser surface: the unregistered `password_must_change`, and the anonymous reset page
 * calls (SPEC §4.10 / §3.1). The preset-side tests (newPassword, passwordPolicy)
 * live in bff-realmid/src/preset.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classifyHttpStatus, RealmError } from "./errors.js";
import {
  createPasswordReset,
  PASSWORD_RESET_CODES,
  passwordResetCode,
} from "./password-reset.js";

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(answer: () => Response) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return answer();
  };
  return { calls, fetch };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---- password_must_change ----

test("classify: password_must_change is deliberately NOT registered (SPEC §3.1 note): a 403 stays forbidden", () => {
  assert.equal(classifyHttpStatus(403, { code: "password_must_change" }), "forbidden");
  assert.equal(
    classifyHttpStatus(403, { code: "forbidden", details: { server_code: "password_must_change" } }),
    "forbidden",
  );
});

// ---- reset calls ----

test("inspectPasswordReset: anonymous POST, token in the body, returns {expiresAt}", async () => {
  const { calls, fetch } = fakeFetch(() => json(200, { expires_at: "2026-10-09T12:00:00Z" }));
  const pr = createPasswordReset({ baseUrl: "https://bff.test/", fetch });
  const out = await pr.inspectPasswordReset("tok123");
  assert.deepEqual(out, { expiresAt: "2026-10-09T12:00:00Z" });
  assert.equal(calls[0]!.url, "https://bff.test/auth/password/reset/inspect");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { token: "tok123" });
  assert.equal(calls[0]!.init?.credentials, "omit", "anonymous: no cookie");
  assert.equal(calls[0]!.init?.referrerPolicy, "no-referrer");
  assert.ok(!calls[0]!.url.includes("tok123"), "token never in the URL");
});

test("inspectPasswordReset unwraps a data envelope", async () => {
  const { fetch } = fakeFetch(() => json(200, { data: { expires_at: "x" } }));
  const out = await createPasswordReset({ baseUrl: "https://b", fetch }).inspectPasswordReset("t");
  assert.equal(out.expiresAt, "x");
});

test("consumePasswordReset: POST {token,new_password}, resolves void", async () => {
  const { calls, fetch } = fakeFetch(() => json(200, { status: "password_set" }));
  const pr = createPasswordReset({ baseUrl: "https://bff.test", fetch });
  const out = await pr.consumePasswordReset("tok", "correct horse battery");
  assert.equal(out, undefined);
  assert.equal(calls[0]!.url, "https://bff.test/auth/password/reset");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { token: "tok", new_password: "correct horse battery" });
  assert.equal(calls[0]!.init?.referrerPolicy, "no-referrer");
});

test("a reset refusal throws RealmError and passwordResetCode names the reason", async () => {
  for (const [status, code] of [
    [400, "reset_token_invalid"],
    [410, "reset_token_expired"],
    [410, "reset_token_used"],
    [410, "reset_token_superseded"],
    [400, "password_too_short"],
    [400, "password_too_long"],
    [400, "password_unchanged"],
  ] as const) {
    const { fetch } = fakeFetch(() => json(status, { code, message: "m" }));
    const pr = createPasswordReset({ baseUrl: "https://b", fetch });
    await assert.rejects(pr.consumePasswordReset("t", "p"), (e: unknown) => {
      assert.ok(e instanceof RealmError);
      assert.equal(e.status, status);
      assert.equal(passwordResetCode(e), code);
      return true;
    });
  }
});

test("passwordResetCode also reads details.server_code and ignores foreign codes", () => {
  assert.equal(
    passwordResetCode({ code: "bad_request", details: { server_code: "password_too_short" } }),
    "password_too_short",
  );
  assert.equal(passwordResetCode(new RealmError("bad_request", "x", 400, { code: "nope" })), null);
  assert.equal(passwordResetCode(null), null);
});

test("a lost connection is network_error and is NOT retried", async () => {
  let n = 0;
  const fetch: typeof globalThis.fetch = async () => {
    n++;
    throw new TypeError("offline");
  };
  const pr = createPasswordReset({ baseUrl: "https://b", fetch });
  await assert.rejects(pr.consumePasswordReset("t", "p"), (e: unknown) => e instanceof RealmError && e.code === "network_error");
  assert.equal(n, 1);
});

test("PARITY: reset codes are exactly the SPEC §3.1 / §4.10 set, and SPEC.md names each", () => {
  assert.deepEqual(
    [...PASSWORD_RESET_CODES].sort(),
    [
      "password_too_long",
      "password_too_short",
      "password_unchanged",
      "reset_token_expired",
      "reset_token_invalid",
      "reset_token_superseded",
      "reset_token_used",
    ],
  );
  const spec = readFileSync(new URL("../../../../SPEC.md", import.meta.url), "utf8");
  for (const c of PASSWORD_RESET_CODES) assert.ok(spec.includes(`\`${c}\``), `SPEC.md no longer names ${c}`);
});
