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

test("HttpClient: api key sent as bearer", async () => {
  let seenAuth: string | undefined;
  const f: typeof fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seenAuth = h.get("authorization") ?? undefined;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const c = new HttpClient({ baseUrl: "https://x.example", fetch: f, apiKey: "rk_live_abc" });
  await c.request({ path: "/anything" });
  assert.equal(seenAuth, "Bearer rk_live_abc");
});
