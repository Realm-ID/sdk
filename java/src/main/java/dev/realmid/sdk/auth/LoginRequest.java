package dev.realmid.sdk.auth;

/**
 * SPEC §4.1 — provider token exchange. {@code customClaims} are intentionally
 * not accepted on login; use {@link TokenRequest#customClaims()} on refresh.
 */
public record LoginRequest(String method, String providerToken, String origin) {
    public static LoginRequest of(String method, String providerToken) {
        return new LoginRequest(method, providerToken, null);
    }
}
