package dev.realmid.sdk.auth;

/** SPEC §4.4 — revoke the supplied or current refresh token. */
public record LogoutRequest(String refreshToken, String origin) {
    public static LogoutRequest empty() { return new LogoutRequest(null, null); }
    public static LogoutRequest of(String refreshToken) { return new LogoutRequest(refreshToken, null); }
}
