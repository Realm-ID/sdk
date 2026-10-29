/**
 * Split-signing v3 console surface: `admin.signingKeys.splitStatus` / `.cancelDowngrade`,
 * `admin.platforms.setIntegrationTokenEndpoint`, and the typed `user_api_keys` config view.
 * Wire authority: issuer `signing_split.go` (status handler is raw(), no `data` envelope;
 * `last_handshake` is an RFC 3339 STRING there, swagger's "object" is wrong — ui-reconcile F1).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { RealmError } from "@realm-id/sdk";
import type { RequestOptions } from "@realm-id/sdk/internal";

import { createAdmin } from "./index.js";
import { PlatformsClient } from "./platforms.js";
import { SigningKeysClient } from "./signing-keys.js";
import { realmFetchAsHttpClient, type HttpLike } from "./transport.js";
import type { RealmConfigView, SplitSigningStatus, UserApiKeysConfigView } from "./types.js";

function makeHttp(response: unknown): { http: HttpLike; calls: RequestOptions[] } {
  const calls: RequestOptions[] = [];
  const http: HttpLike = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push(opts);
      return response as T;
    },
  };
  return { http, calls };
}

function failingHttp(status: number, code: string) {
  const realm = {
    async fetch() {
      return new Response(JSON.stringify({ error: { code, message: "x" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return realmFetchAsHttpClient(realm as never, { baseUrl: "https://api.partner.com" });
}

function serverCode(e: RealmError): unknown {
  return e.code === (e.details as Record<string, unknown> | undefined)?.["server_code"]
    ? e.code
    : (e.details as Record<string, unknown> | undefined)?.["server_code"] ?? e.code;
}

describe("signingKeys.splitStatus", () => {
  it("GETs /platforms/{id}/signing-keys/split and returns the raw body", async () => {
    const wire: SplitSigningStatus = {
      state: "overlap",
      kid: "k1",
      public_key: { kty: "RSA", n: "n", e: "AQAB" },
      overlap_until: "2026-11-05T00:00:00Z",
      last_handshake: "2026-10-29T10:00:00Z",
    };
    const { http, calls } = makeHttp(wire);
    const out = await new SigningKeysClient(http).splitStatus("p 1");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.path, "/platforms/p%201/signing-keys/split");
    assert.equal(calls[0]!.body, undefined);
    assert.deepEqual(out, wire);
    assert.equal(typeof out.last_handshake, "string");
  });

  it("passes nulls and an unknown state through untouched", async () => {
    const { http } = makeHttp({ state: "future_state", overlap_until: null, last_handshake: null });
    const out = await new SigningKeysClient(http).splitStatus("p1");
    assert.equal(out.state, "future_state");
    assert.equal(out.overlap_until, null);
    assert.equal(out.last_handshake, null);
    assert.equal(out.kid, undefined);
  });

  it("maps 501 split_custody_unavailable to a RealmError, preserving the server code", async () => {
    await assert.rejects(
      () => new SigningKeysClient(failingHttp(501, "split_custody_unavailable")).splitStatus("p1"),
      (e: unknown) => {
        assert.ok(e instanceof RealmError);
        assert.equal(serverCode(e), "split_custody_unavailable");
        return true;
      },
    );
  });
});

describe("signingKeys.cancelDowngrade", () => {
  it("DELETEs /platforms/{id}/signing-keys/split/downgrade with no body", async () => {
    const { http, calls } = makeHttp({ status: "cancelled" });
    const out = await new SigningKeysClient(http).cancelDowngrade("p 1");
    assert.equal(calls[0]!.method, "DELETE");
    assert.equal(calls[0]!.path, "/platforms/p%201/signing-keys/split/downgrade");
    assert.equal(calls[0]!.body, undefined);
    assert.deepEqual(out, { status: "cancelled" });
  });

  it("maps 404 no_pending_downgrade and 403 not_available_to_api_keys", async () => {
    for (const [status, code] of [[404, "no_pending_downgrade"], [403, "not_available_to_api_keys"]] as const) {
      await assert.rejects(
        () => new SigningKeysClient(failingHttp(status, code)).cancelDowngrade("p1"),
        (e: unknown) => {
          assert.ok(e instanceof RealmError);
          assert.equal(serverCode(e), code);
          return true;
        },
      );
    }
  });

  it("is wired onto createAdmin().signingKeys (not admin.keys)", () => {
    const realm = { async fetch() { return new Response("{}"); } };
    const a = createAdmin(realm as never, { baseUrl: "https://api.partner.com" } as never);
    assert.equal(typeof a.signingKeys.splitStatus, "function");
    assert.equal(typeof a.signingKeys.cancelDowngrade, "function");
  });
});

describe("platforms.setIntegrationTokenEndpoint", () => {
  it("PATCHes {integration_token_endpoint: url} and returns the platform", async () => {
    const { http, calls } = makeHttp({ id: "p1", display_name: "P" });
    const out = await new PlatformsClient(http).setIntegrationTokenEndpoint("p 1", "https://partner.example/rid");
    assert.equal(calls[0]!.method, "PATCH");
    assert.equal(calls[0]!.path, "/platforms/p%201");
    assert.deepEqual(calls[0]!.body, { integration_token_endpoint: "https://partner.example/rid" });
    assert.equal(out.id, "p1");
  });

  it("sends an explicit null to clear (the key is present)", async () => {
    const { http, calls } = makeHttp({ id: "p1" });
    await new PlatformsClient(http).setIntegrationTokenEndpoint("p1", null);
    assert.ok(calls[0]!.body && "integration_token_endpoint" in (calls[0]!.body as object));
    assert.deepEqual(calls[0]!.body, { integration_token_endpoint: null });
  });

  it("maps 400 invalid_integration_endpoint and 501 integration_endpoint_unsupported", async () => {
    for (const [status, code] of [[400, "invalid_integration_endpoint"], [501, "integration_endpoint_unsupported"]] as const) {
      await assert.rejects(
        () => new PlatformsClient(failingHttp(status, code)).setIntegrationTokenEndpoint("p1", "http://x"),
        (e: unknown) => {
          assert.ok(e instanceof RealmError);
          assert.equal(serverCode(e), code);
          return true;
        },
      );
    }
  });
});

describe("RealmConfigView.user_api_keys", () => {
  it("is typed, optional, and carries allow_uncapped", () => {
    const uak: UserApiKeysConfigView = {
      enabled: true, max_active: 5, max_ttl_seconds: 100, default_ttl_seconds: 50,
      allow_non_expiring: false, allow_uncapped: false,
      max_permission_strings: 10, max_permission_string_len: 64,
      require_mfa_at_mint: null, org_admin_visible: true,
    };
    const view = { user_api_keys: uak } as unknown as RealmConfigView;
    const allow: boolean | undefined = view.user_api_keys?.allow_uncapped;
    assert.equal(allow, false);
    assert.equal(view.user_api_keys?.require_mfa_at_mint, null);
  });
});
