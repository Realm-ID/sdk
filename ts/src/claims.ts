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
  [k: string]: unknown;
}
