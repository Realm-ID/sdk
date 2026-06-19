/**
 * Firebase Auth provider adapter for @realm-id/web.
 *
 *   import { createFirebaseProvider } from "@realm-id/web-firebase";
 *   const fb = createFirebaseProvider({
 *     firebaseConfig: { apiKey, authDomain, projectId, appId },
 *     mode: "popup", // or "redirect" for webviews
 *   });
 *
 *   // Click handler:
 *   const idToken = await fb.signInWithGoogle();
 *   await realm.login({ method: "firebase", providerToken: idToken });
 *
 * Or one-shot:
 *   await fb.loginWithGoogle(realm); // signs in with Firebase + calls realm.login
 *
 * Redirect-mode lifecycle:
 *   - call fb.completeRedirect(realm) once on app boot to consume any
 *     pending getRedirectResult() and finalize realm.login.
 */

import { initializeApp, type FirebaseApp, type FirebaseOptions } from "firebase/app";
import {
  GoogleAuthProvider,
  getAuth,
  getRedirectResult,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  type Auth,
  type UserCredential,
} from "firebase/auth";
import type { LoginResponse, Realm } from "@realm-id/web";

export interface FirebaseProviderOptions {
  firebaseConfig: FirebaseOptions;
  /** popup (default) or redirect — webviews should use redirect. */
  mode?: "popup" | "redirect";
  /** Force account chooser on Google. Default true. */
  forceAccountSelection?: boolean;
}

export interface FirebaseProvider {
  app: FirebaseApp;
  auth: Auth;
  /** Run Firebase Google flow; returns the Firebase ID token (provider token). */
  signInWithGoogle(): Promise<string>;
  /** Email/password — returns the Firebase ID token. */
  signInWithEmail(email: string, password: string): Promise<string>;
  /** One-shot: signInWithGoogle + realm.login("firebase"). */
  loginWithGoogle(realm: Realm): Promise<LoginResponse | null>;
  /** Consume a pending redirect result on app boot; resolves realm.login if so. */
  completeRedirect(realm: Realm): Promise<LoginResponse | null>;
}

export function createFirebaseProvider(opts: FirebaseProviderOptions): FirebaseProvider {
  const app = initializeApp(opts.firebaseConfig, "@realm-id/web-firebase");
  const auth = getAuth(app);
  const mode = opts.mode ?? "popup";

  const buildGoogleProvider = () => {
    const p = new GoogleAuthProvider();
    if (opts.forceAccountSelection !== false) p.setCustomParameters({ prompt: "select_account" });
    return p;
  };

  async function signInWithGoogle(): Promise<string> {
    if (mode === "redirect") {
      await signInWithRedirect(auth, buildGoogleProvider());
      // Browser navigates away; control returns via completeRedirect().
      return "";
    }
    const cred = await signInWithPopup(auth, buildGoogleProvider());
    return tokenFromCredential(cred);
  }

  async function signInWithEmail(email: string, password: string): Promise<string> {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return tokenFromCredential(cred);
  }

  async function loginWithGoogle(realm: Realm): Promise<LoginResponse | null> {
    const idToken = await signInWithGoogle();
    if (!idToken) return null; // redirect navigated away
    return realm.login({ method: "firebase", providerToken: idToken });
  }

  async function completeRedirect(realm: Realm): Promise<LoginResponse | null> {
    const cred = await getRedirectResult(auth);
    if (!cred) return null;
    const idToken = await tokenFromCredential(cred);
    return realm.login({ method: "firebase", providerToken: idToken });
  }

  return { app, auth, signInWithGoogle, signInWithEmail, loginWithGoogle, completeRedirect };
}

async function tokenFromCredential(cred: UserCredential): Promise<string> {
  return cred.user.getIdToken();
}
