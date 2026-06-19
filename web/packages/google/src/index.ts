/**
 * Google Identity Services (GIS) adapter for @realm-id/web.
 *
 * Loads `https://accounts.google.com/gsi/client`, runs an ID-token flow
 * (FedCM-aware on supporting browsers, popup fallback otherwise), and
 * hands the resulting ID token to the partner-supplied login callback.
 *
 *   const google = createGoogleProvider({ clientId: "..." });
 *   const idToken = await google.signIn();
 *   await realm.login({ method: "google", providerToken: idToken });
 *
 * For webviews where popups don't work, use mode: "redirect" and call
 * google.completeRedirect(realm) on app boot.
 */

import type { LoginResponse, Realm } from "@realm-id/web";

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize(cfg: GisInitConfig): void;
          prompt(cb?: (n: GisPromptNotification) => void): void;
          cancel(): void;
        };
        oauth2?: {
          initCodeClient(cfg: GisCodeClientCfg): { requestCode(): void };
        };
      };
    };
  }
}

interface GisInitConfig {
  client_id: string;
  callback: (resp: { credential: string }) => void;
  auto_select?: boolean;
  use_fedcm_for_prompt?: boolean;
  ux_mode?: "popup" | "redirect";
  login_uri?: string;
}

interface GisPromptNotification {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  getNotDisplayedReason(): string;
}

interface GisCodeClientCfg {
  client_id: string;
  scope: string;
  ux_mode: "popup" | "redirect";
  redirect_uri?: string;
  callback?: (resp: { code: string }) => void;
}

export interface GoogleProviderOptions {
  clientId: string;
  /** popup (default) — uses google.accounts.id.prompt() with FedCM. redirect for webviews. */
  mode?: "popup" | "redirect";
  /** Where Google redirects in `mode: "redirect"`. Defaults to current pathname. */
  redirectUri?: string;
  /** Override script URL (rarely useful — for tests). */
  scriptUrl?: string;
}

export interface GoogleProvider {
  signIn(): Promise<string>;
  loginWith(realm: Realm): Promise<LoginResponse | null>;
  completeRedirect(realm: Realm): Promise<LoginResponse | null>;
}

const SCRIPT_URL = "https://accounts.google.com/gsi/client";

export function createGoogleProvider(opts: GoogleProviderOptions): GoogleProvider {
  const mode = opts.mode ?? "popup";
  const scriptUrl = opts.scriptUrl ?? SCRIPT_URL;

  let scriptPromise: Promise<void> | null = null;
  function loadScript(): Promise<void> {
    if (typeof window === "undefined") return Promise.reject(new Error("not in browser"));
    if (window.google?.accounts?.id) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = scriptUrl;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("failed to load Google Identity Services"));
      document.head.appendChild(s);
    });
    return scriptPromise;
  }

  async function signIn(): Promise<string> {
    await loadScript();
    const id = window.google?.accounts?.id;
    if (!id) throw new Error("google.accounts.id unavailable");

    if (mode === "redirect") {
      // Redirect mode requires a server endpoint to receive the ID token; we
      // provide a sentinel and let completeRedirect() consume it.
      id.initialize({
        client_id: opts.clientId,
        callback: () => {},
        ux_mode: "redirect",
        login_uri: opts.redirectUri ?? window.location.href,
      });
      id.prompt();
      return ""; // browser navigates away
    }

    return new Promise<string>((resolve, reject) => {
      id.initialize({
        client_id: opts.clientId,
        use_fedcm_for_prompt: true,
        callback: (resp) => {
          if (resp.credential) resolve(resp.credential);
          else reject(new Error("no credential returned"));
        },
      });
      id.prompt((notification) => {
        if (notification.isNotDisplayed()) {
          reject(new Error(`prompt suppressed: ${notification.getNotDisplayedReason()}`));
        }
      });
    });
  }

  async function loginWith(realm: Realm): Promise<LoginResponse | null> {
    const idToken = await signIn();
    if (!idToken) return null;
    return realm.login({ method: "google", providerToken: idToken });
  }

  async function completeRedirect(realm: Realm): Promise<LoginResponse | null> {
    // Redirect mode: GIS posts the credential to `login_uri`. Most apps
    // round-trip via the BFF instead; expose a best-effort URL-fragment
    // parse for SPAs that wire `login_uri` to the same SPA entry.
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const credential = params.get("credential") || params.get("id_token");
    if (!credential) return null;
    return realm.login({ method: "google", providerToken: credential });
  }

  return { signIn, loginWith, completeRedirect };
}
