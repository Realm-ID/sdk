import { test } from "node:test";
import { strict as assert } from "node:assert";
import { HttpClient } from "./http.js";
import { RealmError } from "./errors.js";

function fixedFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;
}

test("HttpClient: maps server envelope code", async () => {
  const c = new HttpClient({
    baseUrl: "https://x.example",
    fetch: fixedFetch(403, { error: { code: "forbidden", message: "nope" } }),
  });
  await assert.rejects(() => c.request({ path: "/foo" }), (e: Error) => {
    return e instanceof RealmError && e.code === "forbidden" && e.httpStatus === 403 && e.message === "nope";
  });
});

test("HttpClient: 412 envelope siblings flow into details", async () => {
  const c = new HttpClient({
    baseUrl: "https://x.example",
    fetch: fixedFetch(412, {
      error: { code: "mfa_required", message: "MFA challenge issued" },
      mfa_challenge_token: "ch_abc",
      methods: ["totp"],
    }),
  });
  await assert.rejects(() => c.request({ path: "/auth/login", method: "POST" }), (e: Error) => {
    if (!(e instanceof RealmError)) return false;
    if (e.code !== "mfa_required") return false;
    if (e.details?.["mfa_challenge_token"] !== "ch_abc") return false;
    const m = e.details?.["methods"];
    return Array.isArray(m) && m[0] === "totp";
  });
});

test("HttpClient: status fallback when no envelope", async () => {
  const c = new HttpClient({
    baseUrl: "https://x.example",
    fetch: fixedFetch(404, ""),
  });
  await assert.rejects(() => c.request({ path: "/missing" }), (e: Error) => {
    return e instanceof RealmError && e.code === "not_found" && e.httpStatus === 404;
  });
});

test("HttpClient: network error wrapped", async () => {
  const f: typeof fetch = (async () => { throw new Error("dns boom"); }) as typeof fetch;
  const c = new HttpClient({ baseUrl: "https://x.example", fetch: f });
  await assert.rejects(() => c.request({ path: "/x" }), (e: Error) => {
    return e instanceof RealmError && e.code === "network" && /dns boom/.test(e.message);
  });
});

test("HttpClient: 204 returns undefined", async () => {
  const f: typeof fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const c = new HttpClient({ baseUrl: "https://x.example", fetch: f });
  const out = await c.request({ path: "/x", method: "DELETE" });
  assert.equal(out, undefined);
});

test("HttpClient: platform-token manager bearer is sent on every request (SPEC §4.0)", async () => {
  let seenAuth: string | undefined;
  const f: typeof fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seenAuth = h.get("authorization") ?? undefined;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // Stub platform-token manager that hands out a fixed token without ever
  // hitting the network. Confirms HttpClient never bypasses it.
  const stubMgr = {
    getToken: async () => "pt_stub_value",
    invalidate: () => {},
  } as unknown as import("./platform-token-manager.js").PlatformTokenManager;
  const c = new HttpClient({ baseUrl: "https://x.example", fetch: f, platformTokens: stubMgr });
  await c.request({ path: "/anything" });
  assert.equal(seenAuth, "Bearer pt_stub_value");
});

// ─── SPEC §3.1 taxonomy ──────────────────────────────────────────────────────
// These assert the CONSEQUENCE of registering a code, not the presence of a
// string in a list — a membership assertion is satisfied by a list nothing
// reads. The consequence is that the server's specific code survives to
// `error.code` instead of collapsing into the HTTP-status fallback.

async function codeFor(status: number, body: unknown): Promise<string> {
  const f: typeof fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  const c = new HttpClient({ baseUrl: "https://x.example", fetch: f });
  try {
    await c.request({ path: "/platforms/p1" });
  } catch (e) {
    return (e as RealmError).code;
  }
  throw new Error("expected the request to reject");
}

test("errors: platform_not_found survives to error.code (SPEC §3.1)", async () => {
  // Before it was registered this returned "not_found" — statusToCode(404) —
  // so a caller could not tell "no such platform" from any other 404.
  assert.equal(
    await codeFor(404, { code: "platform_not_found", message: "platform not found" }),
    "platform_not_found",
  );
});

test("errors: mfa_registration_required survives to error.code (SPEC §3.1)", async () => {
  // The ENROLLMENT variant of the MFA gate. Go has carried it since ADR-061;
  // ts did not, so it collapsed into the 412 fallback for exactly the clients
  // that must render an enrollment screen rather than a code prompt.
  assert.equal(
    await codeFor(412, { code: "mfa_registration_required", message: "enroll first" }),
    "mfa_registration_required",
  );
});

test("errors: an UNregistered code still falls back to the status", async () => {
  // The control. Without it the two tests above pass against an SDK that
  // simply echoes whatever `code` the server sent, which would make the
  // registration they exist to check irrelevant.
  assert.equal(
    await codeFor(404, { code: "definitely_not_a_registered_code", message: "x" }),
    "not_found",
  );
});
