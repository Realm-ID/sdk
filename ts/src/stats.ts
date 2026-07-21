/**
 * Platform KPI rollup (issuer v0.52.0) — `realm.stats.get()`.
 *
 *   GET /platforms/{pid}/stats
 *
 * One request answers the whole dashboard strip — org + user counts, human
 * sign-ins in the trailing 24h, and MFA coverage — from a single server-side
 * query. Authorization is the ADR-074 `users:read` permission (realm owner and
 * the platform's own service/platform token are implicit-all); RealmID staff
 * get no special path (ADR-067), so a platform you do not own is not readable.
 * The server caches the rollup for 30 seconds, so polling faster than that
 * returns the same snapshot.
 */

import type { HttpClient } from "./http.js";

/**
 * MFA-enrollment fraction of the platform's eligible user population,
 * reported as its raw parts so a caller can render "8 of 40" rather than
 * only a rounded percentage.
 */
export interface MfaCoverage {
  covered_users: number;
  eligible_users: number;
  /**
   * `null` when `eligible_users === 0` — there is no coverage of an empty
   * population, and `0` would read as "nobody has MFA". Null-check before
   * formatting.
   */
  percent: number | null;
}

/** GET /platforms/{pid}/stats body. */
export interface PlatformStats {
  platform_id: string;
  /** Unix seconds the snapshot was computed; may lag "now" by the 30s cache. */
  generated_at: number;
  /** Organizations (tenants) in the platform. */
  orgs_count: number;
  /** Total user population. */
  users_count: number;
  /**
   * `class="user"` sessions CREATED in the trailing 24 hours — human
   * sign-ins, not tokens minted and not sessions still alive.
   */
  sessions_24h: number;
  mfa_coverage: MfaCoverage;
}

export class StatsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /** GET /platforms/{pid}/stats — the platform KPI rollup (30s server cache). */
  async get(): Promise<PlatformStats> {
    const raw = await this.http.request<PlatformStats>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/stats`,
    });
    return {
      platform_id: raw?.platform_id ?? this.realmId,
      generated_at: raw?.generated_at ?? 0,
      orgs_count: raw?.orgs_count ?? 0,
      users_count: raw?.users_count ?? 0,
      sessions_24h: raw?.sessions_24h ?? 0,
      mfa_coverage: {
        covered_users: raw?.mfa_coverage?.covered_users ?? 0,
        eligible_users: raw?.mfa_coverage?.eligible_users ?? 0,
        // Preserve null — never coerce to 0, which would read as "0% covered".
        percent: raw?.mfa_coverage?.percent ?? null,
      },
    };
  }
}
