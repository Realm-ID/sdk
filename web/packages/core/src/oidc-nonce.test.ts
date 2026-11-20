/**
 * The nonce sent on the authorize request is bound to the sign-in: the id_token
 * the provider returns must echo it, and a callback whose id_token carries a
 * different nonce (or none) is refused before any login request is made.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildAuthorizeUrl, OIDC_STORAGE_KEY } from "./oidc.js";
import { createRealm, RealmError } from "./index.js";

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

function idToken(claims: Record<string, unknown>): string {
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

interface Harness {
  run: (idTokenClaims: Record<string, unknown>) => Promise<unknown>;
  loginCalls: string[];
  nonce: () => string;
}

/** A `window` carrying a pending record built by the real authorize step. */
async function setup(): Promise<Harness & { done: () => void }> {
  const built = await buildAuthorizeUrl({
    type: "google",
    clientId: "client-1",
    redirectUri: "https://app.test/callback",
  });
  const sentNonce = new URL(built.url).searchParams.get("nonce") ?? "";
  const items = new Map<string, string>([[OIDC_STORAGE_KEY, JSON.stringify(built.pending)]]);
  const search = `?code=abc&state=${built.pending.state}`;
  const g = globalThis as Record<string, unknown>;
  g.window = {
    location: { search, href: "https://app.test/callback" + search, origin: "https://app.test", pathname: "/callback", hash: "" },
    history: { replaceState: () => {} },
    sessionStorage: {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    },
  };
  g.document = { title: "app" };

  const loginCalls: string[] = [];
  let claims: Record<string, unknown> = {};
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ id_token: idToken(claims) }), { status: 200 });
    }
    // The session probe `GET /me` runs at construction; only calls after it count.
    if (!u.endsWith("/me")) loginCalls.push(u);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const realm = createRealm({ baseUrl: "https://bff.test", fetch: fakeFetch });
  return {
    loginCalls,
    nonce: () => sentNonce,
    run: (c) => {
      claims = c;
      return realm.completeSignIn();
    },
    done: () => {
      realm.close();
      delete g.window;
      delete g.document;
    },
  };
}

describe("completeSignIn nonce binding", () => {
  it("the authorize request carries the nonce the pending record keeps", async () => {
    const built = await buildAuthorizeUrl({ type: "google", clientId: "c", redirectUri: "https://a.test/cb" });
    const sent = new URL(built.url).searchParams.get("nonce");
    assert.ok(sent && sent.length >= 16);
    assert.equal((built.pending as { nonce?: string }).nonce, sent);
  });

  it("refuses an id_token whose nonce differs, and makes no login request", async () => {
    const h = await setup();
    try {
      await assert.rejects(
        () => h.run({ sub: "u1", nonce: "not-the-one-we-sent" }),
        (e: unknown) => e instanceof RealmError && /nonce/i.test(e.message),
      );
      assert.deepEqual(h.loginCalls, []);
    } finally {
      h.done();
    }
  });

  it("refuses an id_token carrying no nonce", async () => {
    const h = await setup();
    try {
      await assert.rejects(
        () => h.run({ sub: "u1" }),
        (e: unknown) => e instanceof RealmError && /nonce/i.test(e.message),
      );
      assert.deepEqual(h.loginCalls, []);
    } finally {
      h.done();
    }
  });

  it("control: an id_token echoing the nonce proceeds to login", async () => {
    const h = await setup();
    try {
      await h.run({ sub: "u1", nonce: h.nonce() }).catch(() => {});
      assert.equal(h.loginCalls.length > 0, true, "the matching nonce must reach login");
    } finally {
      h.done();
    }
  });
});
