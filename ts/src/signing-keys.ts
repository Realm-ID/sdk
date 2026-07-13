/**
 * Owner-facing signing-key surface (roles/signing-keys overhaul).
 *
 * A platform owner reads their realm's keyring and self-serve rotates the
 * active signing key:
 *   - GET  /platforms/{id}/signing-keys        — keyring + rotation policy
 *   - POST /platforms/{id}/signing-keys/rotate — mint a new active key
 *
 * Distinct from the base-staff ops rotate at `/admin/platforms/{id}/…`
 * (that surface lives only in `@realm-id/web-admin`). Both are realm-admin
 * gated server-side; this client targets the owner's own realm.
 */

import type { HttpClient } from "./http.js";

/** One key in the realm's signing keyring. */
export interface SigningKey {
  kid: string;
  /** Unix seconds the key was created. */
  created_at: number;
  /** Unix seconds the key stops being used to sign new tokens. */
  active_until: number;
  /** Unix seconds the key is dropped from the JWKS entirely. */
  retire_at: number;
  /** True for the key currently minting tokens. */
  is_current: boolean;
}

/** The realm's rotation policy as reported by the keyring read. */
export interface SigningKeyRotation {
  mode: "auto" | "manual";
  /** Cadence when `mode === "auto"`; omitted for manual or unset. */
  interval?: "1w" | "1mo" | "1y";
  /** Unix seconds the worker next mints a replacement; omitted in manual mode. */
  next_rotation_at?: number;
}

export interface SigningKeysResponse {
  keys: SigningKey[];
  rotation: SigningKeyRotation;
}

/** Result of a rotate: the new current `kid` plus any retired kids. */
export interface RotateSigningKeyResult {
  kid: string;
  retired_kids: string[];
}

export class SigningKeysClient {
  constructor(
    private readonly http: HttpClient,
    private readonly realmId: string,
  ) {}

  /** GET /platforms/{id}/signing-keys — keyring newest-first + rotation policy. */
  async list(): Promise<SigningKeysResponse> {
    const raw = await this.http.request<SigningKeysResponse>({
      method: "GET",
      path: `/platforms/${encodeURIComponent(this.realmId)}/signing-keys`,
    });
    return {
      keys: Array.isArray(raw?.keys) ? raw.keys : [],
      rotation: raw?.rotation ?? { mode: "auto" },
    };
  }

  /**
   * POST /platforms/{id}/signing-keys/rotate — self-serve rotate. Shares the
   * server-side rotator + rate limiter with the ops route (429 `rate_limited`
   * when called too frequently).
   */
  async rotate(): Promise<RotateSigningKeyResult> {
    const raw = await this.http.request<RotateSigningKeyResult>({
      method: "POST",
      path: `/platforms/${encodeURIComponent(this.realmId)}/signing-keys/rotate`,
    });
    return { kid: raw?.kid ?? "", retired_kids: raw?.retired_kids ?? [] };
  }
}
