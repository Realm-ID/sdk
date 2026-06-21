/**
 * Lazy Firebase sign-in driver.
 *
 * Firebase isn't plain OIDC — it needs the Firebase JS SDK, initialized from
 * the project's PUBLIC web config (apiKey/authDomain/projectId/appId — not
 * secrets). To keep the RealmID web SDK config-free, that config is served by
 * RI via `realm.providers()` (the provider row's `config` blob) and passed in
 * here. `firebase/app` + `firebase/auth` are imported dynamically so apps that
 * don't use Firebase never bundle it; they're an optional peer dependency.
 */

export interface FirebaseWebConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  appId?: string;
  // Other optional Firebase fields pass through untouched.
  [k: string]: unknown;
}

/**
 * Open the Firebase Google popup and return the Firebase ID token, which the
 * issuer verifies (per-realm Firebase project). `config` is the RI-served
 * public Firebase web config.
 */
export async function signInWithFirebase(config: Record<string, unknown>): Promise<string> {
  const cfg = config as FirebaseWebConfig;
  if (!cfg.apiKey || !cfg.projectId) {
    throw new Error(
      "firebase sign-in requires the Firebase web config (apiKey/projectId) — configure it in RI for the firebase provider",
    );
  }

  // Indirect specifiers + `any` keep `firebase` a truly optional peer dep:
  // TS doesn't require its types and bundlers don't try to resolve it at
  // build time (only apps that actually call firebase sign-in need it).
  const appPath = "firebase/app";
  const authPath = "firebase/auth";
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let appMod: any;
  let authMod: any;
  try {
    appMod = await import(/* @vite-ignore */ appPath);
    authMod = await import(/* @vite-ignore */ authPath);
  } catch {
    throw new Error(
      "firebase sign-in needs the `firebase` package installed in your app (optional peer dependency)",
    );
  }

  // Reuse a named app so repeated sign-ins don't re-initialize.
  const NAME = "@realm-id/web";
  const existing = appMod.getApps().find((a: { name: string }) => a.name === NAME);
  const app = existing ?? appMod.initializeApp(cfg as Record<string, string>, NAME);

  const auth = authMod.getAuth(app);
  const provider = new authMod.GoogleAuthProvider();
  const cred = await authMod.signInWithPopup(auth, provider);
  return cred.user.getIdToken();
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
