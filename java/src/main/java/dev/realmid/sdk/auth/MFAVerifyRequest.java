package dev.realmid.sdk.auth;

/**
 * SPEC §4.3 — completes an MFA challenge.
 *
 * <p>{@code refreshToken} is optional (go 0.64.2): the session's CURRENT refresh
 * token. When set the call takes the same per-session lock as refresh, waits
 * for it, and stores the rotated token as the outcome a waiting refresh adopts
 * (under ADR-109 Issuer B a verify racing a refresh of one session is a reuse
 * and revokes it). It is NEVER sent on the wire. Empty means no lock (a
 * first-login MFA has no session). The middleware leaves it unset because it
 * already holds the lock, which is not re-entrant.
 */
public record MFAVerifyRequest(String challengeToken, String code, String method, String origin,
                               String refreshToken) {

    public MFAVerifyRequest(String challengeToken, String code, String method, String origin) {
        this(challengeToken, code, method, origin, null);
    }

    public static MFAVerifyRequest of(String challengeToken, String code) {
        return new MFAVerifyRequest(challengeToken, code, "totp", null, null);
    }

    /** A copy that runs under the per-session lock keyed on {@code refreshToken}. */
    public MFAVerifyRequest withRefreshToken(String refreshToken) {
        return new MFAVerifyRequest(challengeToken, code, method, origin, refreshToken);
    }
}
