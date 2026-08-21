package dev.realmid.sdk.auth;

/**
 * SPEC §4.1 — provider token exchange. {@code customClaims} are intentionally
 * not accepted on login; use {@link TokenRequest#customClaims()} on refresh.
 *
 * <p>{@code deviceName} (ADR-062) is a human-readable label for the device this
 * login happens on (a CLI hostname, a browser name). It travels as the
 * {@code X-Device-Name} header — never in the body — and the issuer persists it
 * on the created session so a user can tell their sessions apart when revoking
 * one ({@code GET /auth/sessions} → {@link Session#deviceName()}). The server
 * strips control characters and caps it at 120 characters, so no client-side
 * sanitizing is duplicated here.
 */
public record LoginRequest(String method, String providerToken, String origin, String deviceName) {

    /** Pre-ADR-062 constructor; records no device label. */
    public LoginRequest(String method, String providerToken, String origin) {
        this(method, providerToken, origin, null);
    }

    public static LoginRequest of(String method, String providerToken) {
        return new LoginRequest(method, providerToken, null, null);
    }

    /** Returns a copy carrying the ADR-062 device label. */
    public LoginRequest withDeviceName(String deviceName) {
        return new LoginRequest(method, providerToken, origin, deviceName);
    }
}
