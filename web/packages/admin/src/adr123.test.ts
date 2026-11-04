/**
 * ADR-123 admin surface: realm config `email_otp_login_enabled` + the `email_otp` group, and the
 * request-only `acknowledge_mailbox_risk` field carried as an `updateConfig` option (never a key of
 * `RealmConfigPatch`, because it is not part of the config view).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { EmailOtpConfig } from "@realm-id/sdk";
import type { RequestOptions } from "@realm-id/sdk/internal";

import { PlatformsClient } from "./platforms.js";
import type { HttpLike } from "./transport.js";
import type { RealmConfigPatch, RealmConfigView } from "./types.js";

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

describe("realm config: emailed sign-in codes (ADR-123)", () => {
  it("types email_otp_login_enabled and the email_otp group on the patch and the view", async () => {
    // Compile-time: no cast needed to write or read either (tsc -p tsconfig.test.json).
    const patch: RealmConfigPatch = { email_otp_login_enabled: true, email_otp: { max_per_window: 8 } };
    const group: EmailOtpConfig = { max_per_window: 5, window_seconds: 900, sign_in_per_ip_per_hour: 10 };
    const { http } = makeHttp({
      id: "p1",
      config: { email_otp_login_enabled: false, email_otp: group } as unknown as RealmConfigView,
    });
    const out = await new PlatformsClient(http).getConfig("p1");
    const on: boolean = out.email_otp_login_enabled;
    const perIp: number | undefined = out.email_otp?.sign_in_per_ip_per_hour;
    assert.equal(on, false);
    assert.equal(perIp, 10);
    assert.equal(patch.email_otp?.max_per_window, 8);
  });

  it("acknowledgeMailboxRisk adds acknowledge_mailbox_risk to the BODY, never to the patch object", async () => {
    const { http, calls } = makeHttp({ id: "p1", config: {} });
    const client = new PlatformsClient(http);
    const patch: RealmConfigPatch = { email_otp_login_enabled: true };
    await client.updateConfig("p1", patch, { acknowledgeMailboxRisk: true });
    assert.deepEqual(calls[0]!.body, { email_otp_login_enabled: true, acknowledge_mailbox_risk: true });
    assert.deepEqual(patch, { email_otp_login_enabled: true }, "the caller's patch is not mutated");
    assert.equal(calls[0]!.query, undefined);
  });

  it("without the option the body is the patch verbatim, and it combines with confirmLockout", async () => {
    const { http, calls } = makeHttp({ id: "p1", config: {} });
    const client = new PlatformsClient(http);
    await client.updateConfig("p1", { email_otp_login_enabled: false });
    assert.deepEqual(calls[0]!.body, { email_otp_login_enabled: false });
    await client.updateConfig("p1", { email_otp_login_enabled: true }, { acknowledgeMailboxRisk: true, confirmLockout: true });
    assert.deepEqual(calls[1]!.body, { email_otp_login_enabled: true, acknowledge_mailbox_risk: true });
    assert.deepEqual(calls[1]!.query, { confirm_lockout: "true" });
  });
});
