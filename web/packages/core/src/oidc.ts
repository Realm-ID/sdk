/**
 * Generic OIDC Authorization-Code + PKCE driver for public SPA clients.
 *
 * Used by `realm.signIn()` for providers that are plain OIDC (microsoft,
 * google). There is NO vendor SDK and NO client secret — the `client_id`
 * comes from `realm.providers()` (configured in RI), and the authorize/token
 * endpoints are fixed per provider. So the web SDK needs no provider config
 * of its own beyond the BFF base URL.
 *
 * Flow: signIn() → redirect to the IdP authorize endpoint with a PKCE
 * challenge → IdP redirects back with ?code → completeSignIn() exchanges the
 * code (PKCE verifier, no secret) for an `id_token` → `realm.login()`.
 */

export interface OidcEndpoints {
  authorize: string;
  token: string;
  scope: string;
}

/** Fixed, well-known endpoints per OIDC provider type. */
export const OIDC_PROVIDERS: Record<string, OidcEndpoints> = {
  // Microsoft Entra ID v2.0, multi-tenant (`common`).
  microsoft: {
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "openid profile email",
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid profile email",
  },
};

export function isOidcProvider(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(OIDC_PROVIDERS, type);
}

export const OIDC_STORAGE_KEY = "realmid:oidc:pending";

export interface PendingOidc {
  verifier: string;
  state: string;
  type: string;
  clientId: string;
  redirectUri: string;
  tenantId?: string;
}

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a);
}

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(digest);
}

/** Build the authorize URL + the pending PKCE state to persist across the redirect. */
export async function buildAuthorizeUrl(args: {
  type: string;
  clientId: string;
  redirectUri: string;
  tenantId?: string;
}): Promise<{ url: string; pending: PendingOidc }> {
  const ep = OIDC_PROVIDERS[args.type];
  if (!ep) throw new Error(`unsupported OIDC provider: ${args.type}`);
  const verifier = randomString(32);
  const challenge = await sha256(verifier);
  const state = randomString(16);
  const nonce = randomString(16);
  const qs = new URLSearchParams({
    client_id: args.clientId,
    response_type: "code",
    redirect_uri: args.redirectUri,
    scope: ep.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    response_mode: "query",
  });
  const pending: PendingOidc = {
    verifier,
    state,
    type: args.type,
    clientId: args.clientId,
    redirectUri: args.redirectUri,
    tenantId: args.tenantId,
  };
  return { url: `${ep.authorize}?${qs.toString()}`, pending };
}

/** Parse an OIDC callback (`?code=&state=`) from a location search string. */
export function readCallback(search: string): { code: string; state: string } | null {
  const p = new URLSearchParams(search);
  const code = p.get("code");
  const state = p.get("state");
  if (!code || !state) return null;
  return { code, state };
}

/** Exchange the authorization code for an id_token (public client, PKCE). */
export async function exchangeCode(args: {
  type: string;
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const ep = OIDC_PROVIDERS[args.type];
  if (!ep) throw new Error(`unsupported OIDC provider: ${args.type}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    code_verifier: args.verifier,
  });
  const f = args.fetchImpl ?? fetch;
  const res = await f(ep.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`oidc token exchange failed (${res.status}): ${text}`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("oidc token response missing id_token");
  return json.id_token;
}
