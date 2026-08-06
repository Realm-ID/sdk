import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PlatformsClient } from "./platforms.js";
import type { HttpLike } from "./transport.js";
import type { RequestOptions } from "@realm-id/sdk/internal";
import type { PlatformStats, RealmConfigView } from "./types.js";

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

describe("PlatformsClient config read/write (issuer v0.52.0)", () => {
  it("getConfig GETs the config path and unwraps the {id, config} envelope", async () => {
    const config = {
      idle_ttl_seconds: 900,
      mfa_policy: "enforced",
      access_token_custom_claim_keys: ["dept"],
    } as unknown as RealmConfigView;
    const { http, calls } = makeHttp({ id: "p 1", config });
    const client = new PlatformsClient(http);

    const out = await client.getConfig("p 1");

    assert.equal(calls[0]!.opts.method, "GET");
    assert.equal(calls[0]!.opts.path, "/platforms/p%201/config");
    // The caller gets the config object itself, not the envelope.
    assert.equal(out.idle_ttl_seconds, 900);
    assert.equal(out.mfa_policy, "enforced");
    assert.deepEqual(out.access_token_custom_claim_keys, ["dept"]);
  });

  it("getConfig preserves a zero value (unset) rather than dropping the key", async () => {
    // Zero means "unset / server default" on the read side, and a UI priming
    // its controls must be able to tell it apart from an absent key.
    const { http } = makeHttp({
      id: "p1",
      config: { idle_ttl_seconds: 0, mfa_policy: "" } as unknown as RealmConfigView,
    });
    const out = await new PlatformsClient(http).getConfig("p1");
    assert.equal(out.idle_ttl_seconds, 0);
    assert.equal(out.mfa_policy, "");
    assert.ok("idle_ttl_seconds" in out);
  });

  it("updateConfig PATCHes the patch body verbatim", async () => {
    const { http, calls } = makeHttp({ id: "p1", config: {} });
    const client = new PlatformsClient(http);

    await client.updateConfig("p1", { idle_ttl_seconds: 600, mfa_policy: "enabled" });

    assert.equal(calls[0]!.opts.method, "PATCH");
    assert.equal(calls[0]!.opts.path, "/platforms/p1/config");
    assert.deepEqual(calls[0]!.opts.body, {
      idle_ttl_seconds: 600,
      mfa_policy: "enabled",
    });
  });
});

describe("PlatformsClient stats", () => {
  it("stats GETs the platform stats path and decodes the rollup", async () => {
    const body: PlatformStats = {
      platform_id: "p1",
      generated_at: 1_784_000_000,
      orgs_count: 4,
      users_count: 40,
      sessions_24h: 12,
      mfa_coverage: { covered_users: 8, eligible_users: 40, percent: 20 },
    };
    const { http, calls } = makeHttp(body);
    const out = await new PlatformsClient(http).stats("p1");

    assert.equal(calls[0]!.opts.method, "GET");
    assert.equal(calls[0]!.opts.path, "/platforms/p1/stats");
    assert.equal(out.sessions_24h, 12);
    assert.equal(out.mfa_coverage.percent, 20);
  });

  it("keeps mfa_coverage.percent null for an empty eligible population", async () => {
    // null must survive as null — coercing it to 0 would render "0% have MFA"
    // for a realm where nobody is even eligible.
    const { http } = makeHttp({
      platform_id: "p1",
      generated_at: 1,
      orgs_count: 0,
      users_count: 0,
      sessions_24h: 0,
      mfa_coverage: { covered_users: 0, eligible_users: 0, percent: null },
    });
    const out = await new PlatformsClient(http).stats("p1");
    assert.equal(out.mfa_coverage.percent, null);
    assert.notEqual(out.mfa_coverage.percent, 0);
  });
});

describe("PlatformsClient.get — the by-id read (issuer v0.87.0)", () => {
  it("GETs /platforms/{id} and returns the row unwrapped", async () => {
    const { http, calls } = makeHttp({
      id: "p1",
      domain: "acme.test",
      admin_tenant_id: "t1",
      display_name: "Acme",
      mfa_policy: "enforced",
    });

    const out = await new PlatformsClient(http).get("p1");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.opts.method, "GET");
    assert.equal(calls[0]!.opts.path, "/platforms/p1");
    // Same row shape as listMine()'s items — the issuer serves both from
    // myPlatformsFor, so this is the singular counterpart, not a new shape.
    assert.equal(out.id, "p1");
    assert.equal(out.display_name, "Acme");
    assert.equal(out.admin_tenant_id, "t1");
    assert.equal(out.mfa_policy, "enforced");
  });

  it("encodes the id into the path", async () => {
    const { http, calls } = makeHttp({});
    await new PlatformsClient(http).get("p 1/x");
    assert.equal(calls[0]!.opts.path, "/platforms/p%201%2Fx");
  });

  it("sends no body and does not fan out to the list", async () => {
    // The whole point of the by-id read is that it replaces paging
    // /platforms/mine and matching client-side. A wrapper that fell back to
    // the list would reintroduce the cap this endpoint exists to remove.
    const { http, calls } = makeHttp({ id: "p1" });
    await new PlatformsClient(http).get("p1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.opts.body, undefined);
    assert.ok(!calls[0]!.opts.path.includes("mine"));
  });
});
