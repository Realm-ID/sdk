/**
 * Bootstrap credential sources — ADR-057.
 *
 * The SDK exchanges a bootstrap credential once at `POST /auth/login` for a
 * platform session. A static API key is one source; a workload's ambient OIDC
 * token (GCP metadata server, GitHub Actions) is another. `fetch()` is called
 * only on initial login + refresh-death — never per request — so a workload
 * source may mint a fresh short-lived token there.
 */
import { RealmError } from "./errors.js";

export interface Credential {
  grantType: string;
  /** Set for grant_type=platform_api_key. */
  apiKey?: string;
  /** Set for grant_type=token-exchange (a workload OIDC JWT). */
  subjectToken?: string;
}

export interface CredentialSource {
  fetch(): Promise<Credential>;
}

export const GRANT_PLATFORM_API_KEY = "platform_api_key";
export const GRANT_TOKEN_EXCHANGE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const SUBJECT_TOKEN_TYPE_JWT = "urn:ietf:params:oauth:token-type:jwt";

/**
 * The global audience the zero-config SDK requests for a workload OIDC token
 * (ADR-057 §7). Must match the issuer's REALMID_FEDERATION_AUDIENCE. The
 * tenant boundary is the binding's match_claims, not this aud.
 */
export const DEFAULT_FEDERATION_AUDIENCE = "https://api.realmid.dev";

/** Static API-key source — today's behavior. `RealmConfig.apiKey` is sugar. */
export function staticApiKey(key: string): CredentialSource {
  return {
    async fetch(): Promise<Credential> {
      if (!key) {
        throw new RealmError({
          code: "unauthorized",
          message: "no API key configured for platform login",
        });
      }
      return { grantType: GRANT_PLATFORM_API_KEY, apiKey: key };
    },
  };
}

const GCP_METADATA_ID_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

/** GCP workload identity (Cloud Run / GKE / GCE) via the metadata server. */
export function googleWorkloadIdentity(
  audience?: string,
  fetchImpl?: typeof fetch,
): CredentialSource {
  const aud = audience || DEFAULT_FEDERATION_AUDIENCE;
  const f = fetchImpl ?? globalThis.fetch.bind(globalThis);
  return {
    async fetch(): Promise<Credential> {
      const url =
        GCP_METADATA_ID_TOKEN_URL +
        "?audience=" +
        encodeURIComponent(aud) +
        "&format=full";
      let resp: Response;
      try {
        resp = await f(url, { headers: { "Metadata-Flavor": "Google" } });
      } catch (e) {
        throw new RealmError({
          code: "server_error",
          message: "gcp metadata fetch: " + (e as Error).message,
          cause: e,
        });
      }
      const text = (await resp.text()).trim();
      if (!resp.ok || !text) {
        throw new RealmError({
          code: "server_error",
          message: `gcp metadata returned HTTP ${resp.status}`,
        });
      }
      return { grantType: GRANT_TOKEN_EXCHANGE, subjectToken: text };
    },
  };
}

/**
 * GitHub Actions OIDC. Requires the workflow to grant `id-token: write`;
 * GitHub injects the request URL + bearer via the runner environment.
 */
export function githubActionsOidc(
  audience?: string,
  fetchImpl?: typeof fetch,
): CredentialSource {
  const aud = audience || DEFAULT_FEDERATION_AUDIENCE;
  const f = fetchImpl ?? globalThis.fetch.bind(globalThis);
  return {
    async fetch(): Promise<Credential> {
      // Read the runner env without depending on @types/node — the GitHub
      // Actions runtime injects these; absent everywhere else.
      const g = globalThis as {
        process?: { env?: Record<string, string | undefined> };
      };
      const env = g.process?.env ?? {};
      const reqUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
      const bearer = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
      if (!reqUrl || !bearer) {
        throw new RealmError({
          code: "unauthorized",
          message:
            "not running in GitHub Actions with `id-token: write` (ACTIONS_ID_TOKEN_REQUEST_* unset)",
        });
      }
      const sep = reqUrl.includes("?") ? "&" : "?";
      const url = reqUrl + sep + "audience=" + encodeURIComponent(aud);
      let resp: Response;
      try {
        resp = await f(url, {
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "application/json; api-version=2.0",
          },
        });
      } catch (e) {
        throw new RealmError({
          code: "server_error",
          message: "github oidc fetch: " + (e as Error).message,
          cause: e,
        });
      }
      const text = await resp.text();
      if (!resp.ok) {
        throw new RealmError({
          code: "server_error",
          message: `github oidc returned HTTP ${resp.status}`,
        });
      }
      let value = "";
      try {
        value = (JSON.parse(text) as { value?: string }).value ?? "";
      } catch {
        value = "";
      }
      if (!value) {
        throw new RealmError({
          code: "server_error",
          message: "github oidc returned no token",
        });
      }
      return { grantType: GRANT_TOKEN_EXCHANGE, subjectToken: value };
    },
  };
}

/**
 * Zero-config default: probe the ambient sources lazily at fetch time. GitHub
 * Actions is tried first (its presence is an unambiguous, network-free env
 * signal); otherwise GCP's metadata server is attempted. The first source that
 * yields a token wins.
 */
export function autoDetectCredential(
  audience?: string,
  fetchImpl?: typeof fetch,
): CredentialSource {
  const sources = [
    githubActionsOidc(audience, fetchImpl),
    googleWorkloadIdentity(audience, fetchImpl),
  ];
  return {
    async fetch(): Promise<Credential> {
      let lastErr: unknown;
      for (const s of sources) {
        try {
          return await s.fetch();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof RealmError
        ? lastErr
        : new RealmError({
            code: "unauthorized",
            message: "no ambient workload identity detected",
          });
    },
  };
}
