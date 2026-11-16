package dev.realmid.sdk.auth;

import java.util.Map;

/**
 * SPEC §10.2 {@code SPEC10_2_custom_claims} (audit e-01) — the ONLY source of custom claims on a
 * mint the SDK runs (refresh, login, MFA, token manager). The middleware refuses a
 * {@code custom_claims} body key.
 *
 * <p><b>Side-effect freedom is a contract.</b> The SDK retries on error (3 attempts) and calls this
 * on every mint with no caching; it must not write, bill, audit or emit. Its inputs are never
 * request data: read the partner's own session state, not the body that triggered the refresh.
 *
 * <p>Returning null or an empty map mints no custom claims. A key that is not printable ASCII or
 * that folds to a reserved name ({@code Sub}, {@code ACR}) refuses the mint with a
 * {@link CustomClaimKeyException}.
 */
@FunctionalInterface
public interface CustomClaimsHandler {
    Map<String, Object> resolve(String tenantId, String userId) throws Exception;
}
