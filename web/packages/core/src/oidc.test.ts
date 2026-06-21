import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAuthorizeUrl,
  exchangeCode,
  isOidcProvider,
  readCallback,
  OIDC_PROVIDERS,
} from "./oidc.js";

describe("oidc driver", () => {
  it("isOidcProvider recognizes plain-OIDC providers only", () => {
    assert.ok(isOidcProvider("microsoft"));
    assert.ok(isOidcProvider("google"));
    assert.ok(!isOidcProvider("firebase"));
    assert.ok(!isOidcProvider("nope"));
  });

  it("buildAuthorizeUrl builds a PKCE S256 request (microsoft)", async () => {
    const { url, pending } = await buildAuthorizeUrl({
      type: "microsoft",
      clientId: "app-123",
      redirectUri: "https://app.example.com/cb",
      tenantId: "ten_1",
    });
    const u = new URL(url);
    assert.equal(
      u.origin + u.pathname,
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    assert.equal(u.searchParams.get("client_id"), "app-123");
    assert.equal(u.searchParams.get("response_type"), "code");
    assert.equal(u.searchParams.get("redirect_uri"), "https://app.example.com/cb");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.ok((u.searchParams.get("code_challenge") ?? "").length > 20);
    assert.equal(u.searchParams.get("state"), pending.state);
    assert.equal(pending.clientId, "app-123");
    assert.equal(pending.tenantId, "ten_1");
    assert.ok(pending.verifier.length >= 20);
    // PKCE verifier must NOT travel in the authorize request.
    assert.equal(u.searchParams.get("code_verifier"), null);
  });

  it("readCallback parses code+state, null otherwise", () => {
    assert.deepEqual(readCallback("?code=abc&state=xyz"), { code: "abc", state: "xyz" });
    assert.equal(readCallback("?state=only"), null);
    assert.equal(readCallback(""), null);
  });

  it("exchangeCode posts the PKCE token request and returns id_token", async () => {
    let captured: { urlStr: string; init: RequestInit } | undefined;
    const fakeFetch = (async (urlStr: string, init: RequestInit) => {
      captured = { urlStr, init };
      return new Response(JSON.stringify({ id_token: "ID.TOKEN.X" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const idt = await exchangeCode({
      type: "google",
      code: "C1",
      verifier: "V1",
      clientId: "cid",
      redirectUri: "https://a/cb",
      fetchImpl: fakeFetch,
    });
    assert.equal(idt, "ID.TOKEN.X");
    assert.equal(captured!.urlStr, OIDC_PROVIDERS.google.token);
    const body = new URLSearchParams(captured!.init.body as string);
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "C1");
    assert.equal(body.get("code_verifier"), "V1");
    assert.equal(body.get("client_id"), "cid");
    assert.equal(body.get("redirect_uri"), "https://a/cb");
  });

  it("exchangeCode rejects when id_token is missing", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: "x" }), { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      exchangeCode({ type: "microsoft", code: "c", verifier: "v", clientId: "id", redirectUri: "r", fetchImpl: fakeFetch }),
      /missing id_token/,
    );
  });

  it("exchangeCode rejects on an HTTP error", async () => {
    const fakeFetch = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(
      exchangeCode({ type: "microsoft", code: "c", verifier: "v", clientId: "id", redirectUri: "r", fetchImpl: fakeFetch }),
      /token exchange failed \(400\)/,
    );
  });
});
