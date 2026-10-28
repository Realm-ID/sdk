/**
 * @internal  Seams between the realm factory and the server-only split-signing entry point
 * (`@realm-id/sdk/split`, SPEC §14.9). This module imports nothing from `split.ts`: it only names the
 * shapes, so the browser-facing graph reaches no split code and no node builtin (browser-exclusion
 * test). A realm built by `createSplitRealm` is registered here with its hooks, and the split entry
 * point reads them back by realm handle.
 */

import type { HttpClient } from "./http.js";
import type { Logger } from "./logger.js";

/** What a split realm adds to the main graph: finishing a half-signed mint, and the R91 window. */
export interface SplitHooks {
  /** Turns a `/auth/token/partial` body into a normal mint body (a finished `access_token`). */
  finish(raw: unknown): Promise<Record<string, unknown>>;
  /** Seconds a retired split key stays trusted: longest `expires_in` seen (floor 15 min) + 5 min. */
  trustWindowSeconds(): number;
}

/** Passed by `createSplitRealm` as the second argument of `createRealm`. */
export interface RealmInternals {
  split?: SplitHooks;
  /** Replaces the JWKS fetch: resolves a verifying key from the partner's own store (R39). */
  keyResolver?: (realmId: string, kid: string) => Promise<CryptoKey>;
}

/** The per-handle facts `@realm-id/sdk/split` needs. */
export interface RealmHandleInternals {
  http: HttpClient;
  realmId: string;
  baseUrl: string;
  logger: Logger;
  now(): number;
  split?: SplitHooks;
}

const registry = new WeakMap<object, RealmHandleInternals>();

export function registerRealm(handle: object, facts: RealmHandleInternals): void {
  registry.set(handle, facts);
}

/** The internals of a realm handle, or undefined for an object that is not one. */
export function internalsOf(handle: object): RealmHandleInternals | undefined {
  return registry.get(handle);
}
