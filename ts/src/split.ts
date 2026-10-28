/**
 * `@realm-id/sdk/split` — the SERVER-ONLY entry point for split signing (SPEC §14.9). Nothing here is
 * reachable from `index.ts` (see `browser-exclusion.test.ts`): the browser packages import the "."
 * entry, and this code needs `node:` builtins.
 *
 * Names follow SPEC §14.9. Deliberate TS idiom differences from Go: `ShareEntry` is a class whose
 * `d_partner` is non-enumerable (Go gets the redaction from a `Format` method); rotation and the
 * integration handler are free functions, so the main graph (`createRealm`) never imports key
 * generation or `node:fs`; the split realm is `createSplitRealm(cfg)`, not a flag on `createRealm`.
 */

import { createRealm, DEFAULT_BASE_URL, type Realm, type RealmConfig } from "./realm.js";
import { RealmError } from "./errors.js";
import { NOOP_LOGGER } from "./logger.js";
import { SplitState } from "./split-state.js";
import type { ShareSource } from "./share-source.js";

export {
  ShareEntry,
  envShareSource,
  fileShareSource,
  isWritable,
  parseShareBundle,
  serializeShareBundle,
  kekId,
  sealEnvelope,
  openEnvelope,
  type PreviousKey,
  type ShareBundle,
  type LoadedShares,
  type ShareSource,
  type WritableShareSource,
  type SourceCallOptions,
  type FileShareOptions,
} from "./share-source.js";
export { completePartial, completeHandshake, coSign, type PartialSigning } from "./cosign.js";
export { rotateSplit, type RotateSplitOptions } from "./rotation.js";
export { createIntegrationTokenHandler, type IntegrationHandlerOptions } from "./integration-handler.js";

export interface SplitRealmConfig extends RealmConfig {
  /** Where the partner's shares live; REQUIRED (R4 mandatory pinning, SPEC §14.4). */
  shareSource: ShareSource;
}

/**
 * A realm whose user tokens come from `/auth/token/partial`, finished here with the partner's share,
 * and whose verifier trusts only the bundle's public keys (never RealmID's JWKS). Throws
 * `RealmError{invalid_config}` without a share source.
 */
export function createSplitRealm(cfg: SplitRealmConfig): Realm {
  const src = cfg?.shareSource as ShareSource | undefined;
  if (!src || typeof src.load !== "function") {
    throw new RealmError({
      code: "invalid_config",
      message: "realmid: createSplitRealm({ shareSource }) is required (a split realm pins its keys from the partner's store)",
    });
  }
  const baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const state = new SplitState(
    src,
    // The expected `iss` of a co-signed token: the issuer's public base URL + "/" + realm id (SPEC §14.4).
    `${baseUrl}/${cfg.realmId}`,
    () => (cfg.clock ? cfg.clock().getTime() : Date.now()),
    cfg.logger ?? NOOP_LOGGER,
  );
  return createRealm(cfg, {
    split: { finish: (raw) => state.finish(raw), trustWindowSeconds: () => state.trustWindowSeconds() },
    keyResolver: async (realmId, kid) => {
      if (realmId !== cfg.realmId) {
        throw new RealmError({ code: "wrong_issuer", message: `realmid: token realm ${JSON.stringify(realmId)} is not this realm` });
      }
      return state.publicKey(kid);
    },
  });
}
