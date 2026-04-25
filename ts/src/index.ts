/**
 * @realmid/sdk — partner SDK for verifying RealmID JWTs.
 *
 * Design anchors:
 *   - ADR-013: the SDK owns token verification. Partner backends do not parse
 *     tokens themselves.
 *   - ADR-020: verifier is realm-agnostic — base URL + expected audience are
 *     the only configured values. JWKS is fetched per-realm on demand using
 *     the realm ID extracted from the iss claim.
 *
 * Uses the Web Crypto API (globalThis.crypto.subtle), so it runs in modern
 * Node (>= 20), Deno, Bun, edge runtimes, and the browser.
 */

export { Verifier, createVerifier } from "./verifier.js";
export type { Config, Claims, VerifyError } from "./verifier.js";
