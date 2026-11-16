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
 *
 * <p>{@code onBehalfOfIp} is the END USER's IP as your server saw it, sent as
 * {@code X-On-Behalf-Of-IP} so the issuer's per-IP limit counts the user, not your server.
 */
public record MFAVerifyRequest(String challengeToken, String code, String method, String origin,
                               String refreshToken, String onBehalfOfIp) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "MFAVerifyRequest[method=" + method + ", origin=" + origin + "]";
    }


    public MFAVerifyRequest(String challengeToken, String code, String method, String origin) {
        this(challengeToken, code, method, origin, null, null);
    }

    public MFAVerifyRequest(String challengeToken, String code, String method, String origin, String refreshToken) {
        this(challengeToken, code, method, origin, refreshToken, null);
    }

    public static MFAVerifyRequest of(String challengeToken, String code) {
        return new MFAVerifyRequest(challengeToken, code, "totp", null, null, null);
    }

    /** A copy that runs under the per-session lock keyed on {@code refreshToken}. */
    public MFAVerifyRequest withRefreshToken(String refreshToken) {
        return new MFAVerifyRequest(challengeToken, code, method, origin, refreshToken, onBehalfOfIp);
    }

    /** A copy carrying the END USER's IP, sent as {@code X-On-Behalf-Of-IP} (SPEC 4.3, 10.1 step 5). */
    public MFAVerifyRequest withOnBehalfOfIp(String onBehalfOfIp) {
        return new MFAVerifyRequest(challengeToken, code, method, origin, refreshToken, onBehalfOfIp);
    }
}
