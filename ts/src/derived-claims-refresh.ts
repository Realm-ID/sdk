/**
 * derived-claims-refresh.ts — resolving the per-mint claims on the REFRESH lane.
 *
 * ## The bug this closes
 *
 * `mintProductRoles` ran on three lanes — `login`, `completeLogin`,
 * `passwordLogin` — and every one of them is a LOGIN. Nothing ran on refresh,
 * and the middleware's refresh minted with `{refreshToken, tenantId,
 * customClaims}` alone. So a BFF-fronted session carried `product_roles` for one
 * access-TTL and then lost it for the rest of its life, while `product-roles.ts`
 * promised in writing that the handler "runs on EVERY mint, refresh included,
 * and nothing caches".
 *
 * `scope` had the same hole with a sharper edge: the issuer NEVER stores `scope`
 * on a session (deliberately, so it cannot go stale), so an unrequested claim is
 * an absent one, and `scopesFrom` reads absence as no granted authority. A
 * `ScopePolicy` gate therefore starts denying everything one access-TTL into
 * every session — which is why a partner refused to ship their ADR-097 cutover.
 *
 * ## Why the resolution happens AFTER the mint
 *
 * A handler needs the user id, and the refresh lane does not have one: it holds
 * a refresh token, and the subject is inside the ACCESS token it does not have
 * yet. So the order is mint → read the subject → resolve → re-mint. The subject
 * is read LOCALLY with {@link peekJwtSubject} (no network, no verification round
 * trip, no JWT library — `@realm-id/sdk` adds none) from a token the issuer just
 * signed and handed us.
 *
 * The alternative — peeking the subject off the EXPIRING access token the caller
 * still holds — would save a round trip, but it reads a token we are explicitly
 * not verifying (its expiry is the reason we are here at all) and it assumes the
 * old token is still in hand at that point in the caller's deployment. A refresh
 * is not on a human's critical path the way a login is, so the round trip is the
 * cheaper mistake to make.
 */

import { resolveProductRoles, type ProductRolesHandler } from "./product-roles.js";
import { resolveScopes, type ScopesHandler } from "./scopes-handler.js";
import { fireIdentityResolved, type IdentityResolvedHandler } from "./identity-resolved.js";

/** The subset of a minted token this module reads and rewrites in place. */
export interface RefreshMintResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExp?: number;
  idleTtl?: number;
  tenantId?: string;
}

/** What the enrichment needs from the AuthClient, named so the seam is
 *  testable and so nothing here reaches for the HTTP transport directly. */
export interface RefreshMintDeps {
  productRoles?: ProductRolesHandler;
  scopes?: ScopesHandler;
  /**
   * The post-identity, pre-derived-claims hook (design doc:
   * `../docs/design/pre-mint-hook.md`, OQ-1). Fires on this lane too — a
   * BFF's refresh route is the ONLY tenant-choice route it has, since every
   * middleware requires `tenant_id` on refresh, so skipping this lane would
   * leave the exact deployment class that asked for this hook uncovered.
   */
  onIdentityResolved?: IdentityResolvedHandler;
  /** Needed only to populate {@link IdentityResolvedEvent.realmId}. */
  realmId: string;
  mint(req: {
    refreshToken: string;
    tenantId: string;
    productRoles?: string[];
    scope?: string[];
  }): Promise<RefreshMintResult>;
}

/**
 * Re-mints a freshly-refreshed token so it carries the derived claims, updating
 * `out` IN PLACE.
 *
 * It is a NO-OP when neither handler is configured, and that guard is load
 * bearing: it is what keeps the second round trip off every consumer who never
 * adopts either claim. The cost is opt-in with the feature.
 *
 * An error from either handler REFUSES the refresh rather than minting without
 * the claim. Minting anyway would hand back a token that reads as "no granted
 * authority" to every gate — turning a transient blip in the partner's role
 * store into an authorization outage that our own logs record as a clean 200.
 * The same rule `ProductRolesError` already states, and the same rule the issuer
 * applies to an undelivered OTP.
 */
export async function enrichRefreshMint(
  deps: RefreshMintDeps,
  out: RefreshMintResult | undefined,
  tenantId: string,
): Promise<void> {
  // The hook must be consulted here too — a hook-only consumer (no
  // productRoles, no scopes) would otherwise never fire on refresh at all.
  if (!deps.productRoles && !deps.scopes && !deps.onIdentityResolved) return;
  if (!out || !out.refreshToken) {
    // Nothing to re-mint against. A credential-bootstrapped session gets no
    // refresh token at all (ADR-089), so this is a legitimate shape and not an
    // error — there is simply no second mint to make.
    return;
  }
  // Prefer the tenant the issuer actually settled on over the one we asked for:
  // on a tenant switch they differ, and resolving for the requested tenant while
  // the token is minted for another is a silent wrong answer.
  const effectiveTenant = out.tenantId || tenantId;
  const fields = peekJwtUserFields(out.accessToken);
  if (!fields.sub) {
    // Deliberately NOT an error for everyone else. The peek is a convenience
    // over a token the issuer signed; if its shape ever changes we degrade to
    // the old behaviour (the claim is omitted) rather than breaking every
    // refresh. The regression tests assert the subject reaches the handler, so
    // this branch cannot silently become the normal path without turning them
    // red.
    //
    // ⚠️ EXCEPT when onIdentityResolved is configured: its contract is
    // "identity is known", and silently not firing here is exactly the
    // failure Traide came to us with. Refuse the refresh instead. This
    // reaches zero current consumers — nobody can have configured a handler
    // that does not exist yet.
    if (deps.onIdentityResolved) {
      throw new Error(
        "onIdentityResolved is configured but the refreshed token's subject could not be read",
      );
    }
    return;
  }
  const userId = fields.sub;

  await fireIdentityResolved(deps.onIdentityResolved, {
    flow: "refresh",
    realmId: deps.realmId,
    tenantId: effectiveTenant,
    userId,
    role: "",
    email: fields.email,
    displayName: fields.name,
  });

  const roles = await resolveProductRoles(deps.productRoles, effectiveTenant, userId);
  const scopes = await resolveScopes(deps.scopes, effectiveTenant, userId);
  if (!roles?.length && !scopes?.length) {
    // Both empty means both claims would be omitted, so the re-mint could only
    // reproduce the token we are already holding. Skipping it also keeps a
    // handler that legitimately returns nothing from costing a round trip on
    // every refresh forever.
    return;
  }

  // Re-mint against the ROTATED refresh token. The first mint already spent the
  // one the caller presented; re-using it would fail as a replay.
  const again = await deps.mint({
    refreshToken: out.refreshToken,
    tenantId: effectiveTenant,
    productRoles: roles,
    scope: scopes,
  });
  out.accessToken = again.accessToken;
  out.refreshToken = again.refreshToken;
  out.expiresIn = again.expiresIn;
  if (again.refreshExp) out.refreshExp = again.refreshExp;
  if (again.idleTtl) out.idleTtl = again.idleTtl;
}

/**
 * Decodes a JWT payload WITHOUT verifying it and returns its `sub`, or `""` on
 * anything malformed.
 *
 * Not verified on purpose and safely so: the token was minted by the issuer and
 * handed back over the SDK's own authenticated call moments earlier. There is no
 * attacker-controlled path into this string, and verifying it would cost a JWKS
 * round trip on every refresh to learn a value the SDK is about to send straight
 * back to the same issuer, which re-derives the subject from the refresh token
 * regardless.
 */
export function peekJwtSubject(jwt: string): string {
  return decodeJwtPayload(jwt)?.sub ?? "";
}

/**
 * Decodes a JWT payload WITHOUT verifying it and returns its `sub`, `email`,
 * and `name` claims (each `""` on anything malformed or absent) — the `email`
 * / `displayName` source for {@link IdentityResolvedEvent} on the refresh
 * lane, where the wire response carries neither directly (unlike the login
 * lanes, whose `user` object already has them). Same non-verification
 * rationale as {@link peekJwtSubject}.
 */
export function peekJwtUserFields(jwt: string): { sub: string; email: string; name: string } {
  const c = decodeJwtPayload(jwt);
  return { sub: c?.sub ?? "", email: c?.email ?? "", name: c?.name ?? "" };
}

function decodeJwtPayload(jwt: string): { sub?: string; email?: string; name?: string } | undefined {
  const parts = (jwt ?? "").split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (payload === undefined) return undefined;
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const c = JSON.parse(json) as { sub?: unknown; email?: unknown; name?: unknown };
    return {
      sub: typeof c.sub === "string" ? c.sub : undefined,
      email: typeof c.email === "string" ? c.email : undefined,
      name: typeof c.name === "string" ? c.name : undefined,
    };
  } catch {
    return undefined;
  }
}
