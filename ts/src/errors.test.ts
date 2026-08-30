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

// ---- the cross-language contract key (2026-08-30) ----

test("HttpClient: an uncanonical code is preserved under details.server_code", async () => {
  // `server_code` is the key ALL THREE SDKs use for a code the ErrorCode union
  // cannot carry (SPEC.md 3.3). It is named here so a rename cannot pass
  // silently: `@realm-id/web-admin`'s `isCode()`, `@realm-id/web`'s
  // `membershipActionCode()` and two console screens branch on this exact key.
  const c = new HttpClient({
    baseUrl: "https://x.example",
    fetch: fixedFetch(403, { error: { code: "role_owner_only", message: "only the owner may seat this role" } }),
  });
  await assert.rejects(() => c.request({ path: "/tenants/t1/users/u1/role", method: "PATCH" }), (e: Error) => {
    if (!(e instanceof RealmError)) return false;
    if (e.code !== "forbidden") return false; // narrowed to the union
    if (e.details?.["server_code"] !== "role_owner_only") return false;
    return e.message === "only the owner may seat this role";
  });
});

test("HttpClient: the issuer's real step-up 412 reaches the caller with its token", async () => {
  // The gate payload is NESTED inside `error` — GoFr merges the issuer's
  // `Response()` map into one object and renders it under that key. A caller
  // that cannot read it is holding a challenge it has no token to answer.
  const c = new HttpClient({
    baseUrl: "https://x.example",
    fetch: fixedFetch(412, {
      error: {
        code: "mfa_required",
        message: "this operation requires a fresh MFA proof",
        mfa_challenge_token: "chal-xyz",
        methods: ["totp"],
        reason: "stale_mfa",
      },
    }),
  });
  await assert.rejects(() => c.request({ path: "/platforms/p1/keys", method: "POST" }), (e: Error) => {
    if (!(e instanceof RealmError)) return false;
    return e.code === "mfa_required"
      && e.details?.["mfa_challenge_token"] === "chal-xyz"
      && e.details?.["reason"] === "stale_mfa";
  });
});
