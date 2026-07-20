/**
 * Self-service MFA reads/ops for the signed-in admin (ADR-080 §10.4 registry).
 * These are the caller's OWN authenticators/recovery codes — the same
 * self-service class as `SessionsClient` (which lists/revokes the caller's own
 * `/auth/sessions`), so they live in web-admin alongside it rather than in the
 * partner tenant-app SDK. Both endpoints are issuer routes reached via the BFF
 * `/api` passthrough (`/auth/mfa/*` is not a BFF-direct prefix).
 */

import type { HttpLike } from "./transport.js";
import type { AuthenticatorList, RecoveryCodes } from "./types.js";

export class MfaClient {
  constructor(private readonly http: HttpLike) {}

  /**
   * GET /auth/mfa/authenticators — the caller's enrolled MFA authenticator(s)
   * plus remaining backup-code count. A read; NOT MFA-gated. Today only TOTP
   * is supported, so `authenticators` has 0 or 1 entries.
   */
  async listAuthenticators(): Promise<AuthenticatorList> {
    return this.http.request<AuthenticatorList>({
      method: "GET",
      path: "/auth/mfa/authenticators",
    });
  }

  /**
   * POST /auth/mfa/recovery/regenerate — mint a fresh set of one-time recovery
   * codes, invalidating the previous set. Shown once. Requires a CONFIRMED
   * enrollment (else RealmError(conflict)/`not_enrolled`, 409) and a FRESH TOTP
   * within the elevated window (else RealmError(mfa_required), 412 — prompt the
   * user to re-complete TOTP, then retry).
   */
  async regenerateRecoveryCodes(): Promise<RecoveryCodes> {
    return this.http.request<RecoveryCodes>({
      method: "POST",
      path: "/auth/mfa/recovery/regenerate",
    });
  }
}
