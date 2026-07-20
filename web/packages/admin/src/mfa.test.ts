import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MfaClient } from "./mfa.js";
import type { HttpLike } from "./transport.js";
import type { RequestOptions } from "@realm-id/sdk/internal";

interface Captured {
  opts: RequestOptions;
}

function makeHttp(response: unknown): { http: HttpLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const http: HttpLike = {
    async request<T>(opts: RequestOptions): Promise<T> {
      calls.push({ opts });
      return response as T;
    },
  };
  return { http, calls };
}

describe("MfaClient (ADR-080 self-service)", () => {
  it("listAuthenticators GETs /auth/mfa/authenticators", async () => {
    const resp = {
      authenticators: [{ type: "totp", confirmed: true, created_at: 1, confirmed_at: 2 }],
      backup_codes_remaining: 8,
    };
    const { http, calls } = makeHttp(resp);
    const client = new MfaClient(http);
    const out = await client.listAuthenticators();
    assert.deepEqual(out, resp);
    assert.equal(calls[0]!.opts.method, "GET");
    assert.equal(calls[0]!.opts.path, "/auth/mfa/authenticators");
    assert.equal(calls[0]!.opts.body, undefined);
  });

  it("regenerateRecoveryCodes POSTs /auth/mfa/recovery/regenerate", async () => {
    const resp = { status: "ok", recovery_codes: ["aaa-bbb", "ccc-ddd"] };
    const { http, calls } = makeHttp(resp);
    const client = new MfaClient(http);
    const out = await client.regenerateRecoveryCodes();
    assert.deepEqual(out.recovery_codes, ["aaa-bbb", "ccc-ddd"]);
    assert.equal(calls[0]!.opts.method, "POST");
    assert.equal(calls[0]!.opts.path, "/auth/mfa/recovery/regenerate");
    assert.equal(calls[0]!.opts.body, undefined);
  });
});
