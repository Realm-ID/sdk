// The ONE shared helper for tests whose fake issuer must serve the PLATFORM mint (ts twin of
// sdk/go/auth_mint_helpers_test.go). R49/R71: the platform token (platform_api_key, or a workload
// token exchange) is minted at POST /auth/token only; /auth/login refuses a bot grant. Named
// *.test.ts so tsconfig excludes it from dist; it has no tests of its own.

import { GRANT_PLATFORM_API_KEY, GRANT_TOKEN_EXCHANGE } from "./credential.js";

/** Does this request mint the platform token? POST /auth/token with a bootstrap-credential grant. */
export function isPlatformMint(url: string, init?: { body?: unknown }): boolean {
  if (!url.endsWith("/auth/token")) return false;
  try {
    const b = JSON.parse(String(init?.body ?? "")) as { grant_type?: string };
    return b.grant_type === GRANT_PLATFORM_API_KEY || b.grant_type === GRANT_TOKEN_EXCHANGE;
  } catch {
    return false;
  }
}

/** The finished-platform-token answer of /auth/token (no refresh token, ADR-089). */
export function platformMintResponse(access = "pt_x", expiresIn = 300): Response {
  return new Response(
    JSON.stringify({ status: "ok", subject_type: "platform", access_token: access, expires_in: expiresIn }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The user-session mint answer at /auth/token (login returns a refresh token only; R44). */
export function userMintResponse(access = "at", refresh = "rt2"): Response {
  return new Response(
    JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 900, tenant_id: "t1", role: "member" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
