import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PlatformTokenManager } from "./platform-token-manager.js";
import { staticApiKey, GRANT_TOKEN_EXCHANGE } from "./credential.js";
import type { CredentialSource } from "./credential.js";
import { NOOP_LOGGER } from "./logger.js";
import { RealmError } from "./errors.js";

// SPEC §4.0.1 "Replayed-assertion retry": a workload login answered
// 409 assertion_replayed is retried with a freshly fetched credential after
// 1 s then 2 s, three attempts in all.

const ok = () =>
  new Response(JSON.stringify({ status: "ok", subject_type: "platform", access_token: "at", expires_in: 300 }), {
    status: 200, headers: { "content-type": "application/json" },
  });

function refusal(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message: "assertion already used; fetch a fresh one and retry" } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

/** A workload source whose every fetch yields a new token; counts fetches. */
function seqCred(): { source: CredentialSource; fetches: () => number } {
  let n = 0;
  return {
    source: { fetch: async () => ({ grantType: GRANT_TOKEN_EXCHANGE, subjectToken: `wl-${++n}` }) },
    fetches: () => n,
  };
}

function harness(replies: (attempt: number) => Response, credential: CredentialSource) {
  const subjects: string[] = [];
  const waits: number[] = [];
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    subjects.push(body["subject_token"] ?? body["api_key"] ?? "");
    return replies(subjects.length);
  }) as typeof fetch;
  const mgr = new PlatformTokenManager({
    credential, baseUrl: "https://auth.test", fetch: fetchImpl, logger: NOOP_LOGGER,
    sleep: async (ms) => { waits.push(ms); },
  });
  return { mgr, subjects, waits };
}

test("replay: 409 assertion_replayed is retried with a NEW credential, then succeeds", async () => {
  const c = seqCred();
  const { mgr, subjects, waits } = harness((n) => (n <= 2 ? refusal(409, "assertion_replayed") : ok()), c.source);
  assert.equal(await mgr.getToken(), "at");
  assert.deepEqual(subjects, ["wl-1", "wl-2", "wl-3"]);
  assert.equal(c.fetches(), 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("replay: three failures return the last error unchanged", async () => {
  const c = seqCred();
  const { mgr, subjects, waits } = harness(() => refusal(409, "assertion_replayed"), c.source);
  await assert.rejects(mgr.getToken(), (e: unknown) => {
    assert.ok(e instanceof RealmError);
    assert.equal(e.code, "assertion_replayed");
    assert.equal(e.httpStatus, 409);
    return true;
  });
  assert.equal(subjects.length, 3);
  assert.equal(waits.length, 2);
});

test("replay: a static api-key credential is never retried", async () => {
  const { mgr, subjects, waits } = harness(() => refusal(409, "assertion_replayed"), staticApiKey("rk_live_x"));
  await assert.rejects(mgr.getToken());
  assert.equal(subjects.length, 1);
  assert.equal(waits.length, 0);
});

for (const [name, status, code] of [
  ["another 409 code", 409, "conflict"],
  ["the replay code on a 401", 401, "assertion_replayed"],
  ["a plain 401", 401, "unauthorized"],
] as const) {
  test(`replay: ${name} is never retried`, async () => {
    const { mgr, subjects, waits } = harness(() => refusal(status, code), seqCred().source);
    await assert.rejects(mgr.getToken());
    assert.equal(subjects.length, 1);
    assert.equal(waits.length, 0);
  });
}

test("replay: abort during the real backoff returns promptly", async () => {
  const subjects: string[] = [];
  const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    subjects.push(String(init?.body));
    return refusal(409, "assertion_replayed");
  }) as typeof fetch;
  const mgr = new PlatformTokenManager({
    credential: seqCred().source, baseUrl: "https://auth.test", fetch: fetchImpl, logger: NOOP_LOGGER,
  });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const start = Date.now();
  await assert.rejects(mgr.getToken({ signal: ac.signal }), (e: unknown) => {
    assert.equal((e as Error).name, "AbortError");
    return true;
  });
  assert.ok(Date.now() - start < 800, "a 1s backoff must be abandoned on abort");
  assert.equal(subjects.length, 1);
});
