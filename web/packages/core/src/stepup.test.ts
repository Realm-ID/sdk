/**
 * Step-up retry wrapper — the four behaviours that make it work, each of which
 * is silent when it breaks. Every test here is written to fail loudly if one
 * behaviour regresses on its own (see `W2-sdk-web.md` for the mutation log).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { withStepUpRetry, type StepUpChallenge, type StepUpVerifyResponse } from "./stepup.js";

type Call = { url: string; init: RequestInit | undefined };

function res(status: number, body?: unknown, ): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch stub that answers from a queue and records every call. */
function stub(answers: Array<() => Response>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchLike = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = answers[Math.min(i, answers.length - 1)];
    i += 1;
    return next();
  };
  return { fetchLike, calls };
}

const VERIFIED: StepUpVerifyResponse = {
  session_token: "NEW_BEARER",
  expires_at: 111,
  user: { id: "u1", email: "u@example.com" },
  tenants: [{ id: "t1", role: "owner" }],
};

function gate(code: string, extra: Record<string, unknown> = {}) {
  return res(412, {
    error: { code, message: "step up" },
    mfa_challenge_token: "CHAL",
    methods: ["totp"],
    reason: "stale_mfa",
    max_age_seconds: 300,
    ...extra,
  });
}

function deps(overrides: Partial<Parameters<typeof withStepUpRetry>[1]> = {}) {
  const adopted: StepUpVerifyResponse[] = [];
  const seen: StepUpChallenge[] = [];
  const base = {
    baseUrl: () => "https://bff.example",
    currentBearer: () => "OLD_BEARER",
    adopt: (v: StepUpVerifyResponse) => { adopted.push(v); },
    prompt: async (c: StepUpChallenge) => { seen.push(c); return "123456"; },
  };
  return { d: { ...base, ...overrides }, adopted, seen };
}

// ---- behaviour 1: classification ----

test("mfa_required is classified as a verify challenge and prompted", async () => {
  const { fetchLike, calls } = stub([() => gate("mfa_required"), () => res(200, { data: VERIFIED }), () => res(200, { data: { ok: true } })]);
  const { d, seen } = deps();
  const wrapped = withStepUpRetry(fetchLike, d);
  const out = await wrapped("https://bff.example/op", { method: "POST" });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "verify");
  assert.equal(seen[0].challengeToken, "CHAL");
  assert.deepEqual(seen[0].methods, ["totp"]);
  assert.equal(seen[0].reason, "stale_mfa");
  assert.equal(seen[0].maxAgeSeconds, 300);
  assert.equal(out.status, 200);
  assert.equal(calls.length, 3);
});

test("mfa_registration_required is classified as an ENROLL challenge, not verify", async () => {
  const { fetchLike } = stub([() => gate("mfa_registration_required"), () => res(200, { data: VERIFIED }), () => res(200, {})]);
  const { d, seen } = deps({ prompt: async () => null });
  // re-capture: the overriding prompt above drops the recording, so use a local one.
  const captured: StepUpChallenge[] = [];
  d.prompt = async (c: StepUpChallenge) => { captured.push(c); return null; };
  const wrapped = withStepUpRetry(fetchLike, d);
  const out = await wrapped("https://bff.example/op", { method: "POST" });

  assert.equal(captured.length, 1, "the enroll challenge is still surfaced to the prompt");
  assert.equal(captured[0].kind, "enroll");
  assert.equal(seen.length, 0);
  assert.equal(out.status, 412, "abandoning returns the ORIGINAL 412 unchanged");
});

test("the session-limit 412 FALLS THROUGH untouched — never prompted, never replayed", async () => {
  const limit = () => res(412, {
    error: { code: "session_limit_reached", message: "too many sessions" },
    revocation_token: "REVOKE_ME",
  });
  const { fetchLike, calls } = stub([limit]);
  const { d, seen } = deps();
  const wrapped = withStepUpRetry(fetchLike, d);
  const out = await wrapped("https://bff.example/auth/login", { method: "POST" });

  assert.equal(seen.length, 0, "no prompt for a session-limit 412");
  assert.equal(calls.length, 1, "no verify, no replay");
  assert.equal(out.status, 412);
  const body = await out.json() as { revocation_token?: string };
  assert.equal(body.revocation_token, "REVOKE_ME", "the gate payload survives for the caller");
});

test("a non-412 response is returned untouched", async () => {
  const { fetchLike, calls } = stub([() => res(403, { error: { code: "forbidden" } })]);
  const { d, seen } = deps();
  const out = await withStepUpRetry(fetchLike, d)("https://bff.example/op");
  assert.equal(out.status, 403);
  assert.equal(seen.length, 0);
  assert.equal(calls.length, 1);
});

// ---- behaviour 2: adopt the freshly minted bearer ----

test("the freshly minted session bearer is ADOPTED and used on the replay", async () => {
  const { fetchLike, calls } = stub([
    () => gate("mfa_required"),
    () => res(200, { data: VERIFIED }),
    () => res(200, { data: { ok: true } }),
  ]);
  const { d, adopted } = deps();
  await withStepUpRetry(fetchLike, d)("https://bff.example/op", {
    method: "POST",
    headers: { Authorization: "Bearer OLD_BEARER", "X-Keep": "me" },
  });

  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].session_token, "NEW_BEARER");

  const replay = calls[2];
  const h = new Headers(replay.init?.headers);
  assert.equal(h.get("authorization"), "Bearer NEW_BEARER", "the replay carries the NEW bearer");
  assert.equal(h.get("x-keep"), "me", "every other header is preserved");
  assert.equal(replay.init?.method, "POST", "the method is preserved");
});

test("a verify that mints no session_token aborts — no adopt, no replay", async () => {
  const { fetchLike, calls } = stub([
    () => gate("mfa_required"),
    () => res(200, { data: { expires_at: 1 } }),
  ]);
  const { d, adopted } = deps();
  const out = await withStepUpRetry(fetchLike, d)("https://bff.example/op");
  assert.equal(adopted.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(out.status, 412);
});

test("a failed verify returns the original 412 rather than the verify's error", async () => {
  const { fetchLike } = stub([() => gate("mfa_required"), () => res(401, { error: { code: "invalid_code" } })]);
  const { d, adopted } = deps();
  const out = await withStepUpRetry(fetchLike, d)("https://bff.example/op");
  assert.equal(out.status, 412);
  assert.equal(adopted.length, 0);
});

// ---- behaviour 3: preserve the acting tenant ----

test("the verify call carries the CURRENT session bearer so the acting tenant is preserved", async () => {
  const { fetchLike, calls } = stub([
    () => gate("mfa_required"),
    () => res(200, { data: VERIFIED }),
    () => res(200, {}),
  ]);
  const { d } = deps();
  await withStepUpRetry(fetchLike, d)("https://bff.example/op", { method: "POST" });

  const verify = calls[1];
  assert.equal(verify.url, "https://bff.example/auth/mfa/verify");
  const h = new Headers(verify.init?.headers);
  assert.equal(h.get("authorization"), "Bearer OLD_BEARER",
    "ADR-059: MFA proof is per (session, tenant) — the verify must bear the CURRENT session");
  assert.equal(JSON.parse(String(verify.init?.body)).mfa_challenge_token, "CHAL");
  assert.equal(JSON.parse(String(verify.init?.body)).code, "123456");
});

test("no current bearer means no Authorization header, not an empty one", async () => {
  const { fetchLike, calls } = stub([() => gate("mfa_required"), () => res(200, { data: VERIFIED }), () => res(200, {})]);
  const { d } = deps({ currentBearer: () => undefined });
  await withStepUpRetry(fetchLike, d)("https://bff.example/op");
  const h = new Headers(calls[1].init?.headers);
  assert.equal(h.get("authorization"), null);
});

// ---- behaviour 4: replay EXACTLY once ----

test("the replay goes through the RAW fetch, so a still-refusing gate cannot loop", async () => {
  // Every call answers 412 mfa_required. A wrapper that replayed through
  // ITSELF would prompt forever; this must prompt exactly once.
  const { fetchLike, calls } = stub([() => gate("mfa_required"), () => res(200, { data: VERIFIED }), () => gate("mfa_required")]);
  const { d, seen } = deps();
  const out = await withStepUpRetry(fetchLike, d)("https://bff.example/op");

  assert.equal(seen.length, 1, "exactly ONE prompt");
  assert.equal(calls.length, 3, "original + verify + one replay, and nothing more");
  assert.equal(out.status, 412, "the second 412 reaches the caller");
});

test("declining the prompt returns the original 412 and never calls verify", async () => {
  const { fetchLike, calls } = stub([() => gate("mfa_required")]);
  const { d } = deps({ prompt: async () => null });
  const out = await withStepUpRetry(fetchLike, d)("https://bff.example/op");
  assert.equal(calls.length, 1);
  assert.equal(out.status, 412);
});

test("with no prompt supplied the wrapper is a pass-through", async () => {
  const { fetchLike, calls } = stub([() => gate("mfa_required")]);
  const { d } = deps({ prompt: undefined });
  const out = await withStepUpRetry(fetchLike, d)("https://bff.example/op");
  assert.equal(calls.length, 1);
  assert.equal(out.status, 412);
});

test("the original 412 body is still readable by the caller after inspection", async () => {
  const { fetchLike } = stub([() => gate("mfa_required")]);
  const { d } = deps({ prompt: async () => null });
  const out = await withStepUpRetry(fetchLike, d)("https://bff.example/op");
  const body = await out.json() as { mfa_challenge_token?: string };
  assert.equal(body.mfa_challenge_token, "CHAL", "parseStepUp must clone, not consume");
});

test("a 412 with an unparseable body falls through", async () => {
  const bad = () => new Response("<html>nope</html>", { status: 412 });
  const { fetchLike, calls } = stub([bad]);
  const { d, seen } = deps();
  const out = await withStepUpRetry(fetchLike, d)("https://bff.example/op");
  assert.equal(seen.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(out.status, 412);
});

test("the verify response is read through the GoFr {data:…} envelope AND unwrapped", async () => {
  // Same fixture, without the envelope: both must work, because the wrapper
  // talks to the BFF raw and GoFr's envelope is not guaranteed forever.
  for (const body of [{ data: VERIFIED }, VERIFIED]) {
    const { fetchLike, calls } = stub([() => gate("mfa_required"), () => res(200, body), () => res(200, {})]);
    const { d, adopted } = deps();
    await withStepUpRetry(fetchLike, d)("https://bff.example/op");
    assert.equal(adopted.length, 1, `session adopted for ${JSON.stringify(body).slice(0, 20)}`);
    assert.equal(new Headers(calls[2].init?.headers).get("authorization"), "Bearer NEW_BEARER");
  }
});
