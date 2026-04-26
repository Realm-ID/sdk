package dev.realmid.sdk.auth;

import java.util.Map;

/**
 * SPEC §4.2 — refresh-token rotation, tenant switch, and custom claim
 * injection on the minted access token.
 */
public record TokenRequest(
        String refreshToken,
        String tenantId,
        Map<String, Object> customClaims,
        String origin) {

    public static TokenRequest of(String refreshToken, String tenantId) {
        return new TokenRequest(refreshToken, tenantId, null, null);
    }

    public static TokenRequest withClaims(String refreshToken, String tenantId,
                                          Map<String, Object> customClaims) {
        return new TokenRequest(refreshToken, tenantId, customClaims, null);
    }
}
