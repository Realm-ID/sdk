/**
 * Org-session mode — SPEC §6.7.3.
 *
 * Read from the realm's discovery document
 * (`GET {baseUrl}/{realm}/.well-known/openid-configuration`, field
 * `realmid_org_sessions`), cached per realm for 10 minutes (the JWKS TTL).
 * An absent field, `""`, an unknown value or a failed fetch all mean
 * `concurrent`: fail-soft = refuse fewer tokens. A failure logs one warning and
 * is retried at the next cache expiry.
 */

import type { Logger } from "./logger.js";
import { NOOP_LOGGER } from "./logger.js";

export type OrgSessionMode = "concurrent" | "exclusive";

/** The discovery field carrying the realm's resolved mode (ADR-109 D10.3). */
export const DISCOVERY_ORG_SESSIONS_FIELD = "realmid_org_sessions";

const TTL_MS = 10 * 60 * 1000;

export interface OrgSessionModeResolverConfig {
  baseUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export class OrgSessionModeResolver {
  private readonly cache = new Map<string, { mode: OrgSessionMode; fetchedAt: number }>();
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(cfg: OrgSessionModeResolverConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = cfg.now ?? (() => Date.now());
    this.logger = cfg.logger ?? NOOP_LOGGER;
  }

  /** The realm's mode; never throws. */
  async get(realmId: string): Promise<OrgSessionMode> {
    const hit = this.cache.get(realmId);
    if (hit && this.now() - hit.fetchedAt < TTL_MS) return hit.mode;
    let mode: OrgSessionMode = "concurrent";
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${realmId}/.well-known/openid-configuration`);
      if (!res.ok) throw new Error(`discovery status ${res.status}`);
      const doc = (await res.json()) as Record<string, unknown>;
      if (doc[DISCOVERY_ORG_SESSIONS_FIELD] === "exclusive") mode = "exclusive";
    } catch (e) {
      this.logger.warn("realmid: org-session mode unavailable, assuming concurrent", {
        realm: realmId,
        message: (e as Error).message,
      });
    }
    this.cache.set(realmId, { mode, fetchedAt: this.now() });
    return mode;
  }

  /** Mode for the realm a token's `iss` names. */
  forIssuer(iss: string): Promise<OrgSessionMode> {
    const i = iss.lastIndexOf("/");
    const realm = i >= 0 ? iss.slice(i + 1) : iss;
    return realm ? this.get(realm) : Promise.resolve("concurrent");
  }
}
