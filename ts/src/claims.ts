/**
 * JWT claims surfaced by `realm.verify()`. Mirrors the canonical claim set
 * minted by auth.realmid.dev. Custom claims (subject to the realm allowlist)
 * appear under arbitrary string keys; consumers cast as needed.
 */

export interface Claims {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat: number;
  nbf?: number;
  jti?: string;
  azp?: string;
  tenant_id?: string;
  role?: string;
  /**
   * ADR-097 granted authority: a space-delimited string of the PARTNER'S own
   * scope strings (RFC 9068 §2.2.3, by reference to RFC 8693 §4.2, in RFC 6749
   * §3.3 format). A STRING, not an array.
   *
   * Already intersected with any user-API-key `permissions_cap` by the issuer,
   * so this is the ONE effective set — nothing downstream has to intersect
   * anything. Read it with `scopesFrom` / `scopeAllows` rather than splitting
   * it by hand.
   *
   * Absent on a token whose caller asked for no scope, and on any token minted
   * before ADR-097. Both read as "no granted authority".
   */
  scope?: string;
  /**
   * ADR-097 #8: the token CLASS — `"platform"` for an ADR-041 partner-broker
   * token, `"integration"` for an ADR-082/083 cross-realm mint, absent on an
   * ordinary user token.
   *
   * This used to ride in `scope`. It moved because RFC 9068 gives that name to
   * granted authority, which is now PARTNER-CONTROLLED — so a partner naming a
   * scope `platform` must not be able to look like a platform token.
   */
  token_class?: string;
  [k: string]: unknown;
}
