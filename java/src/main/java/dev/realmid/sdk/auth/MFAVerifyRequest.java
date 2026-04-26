package dev.realmid.sdk.auth;

/** SPEC §4.3 — completes an MFA challenge. */
public record MFAVerifyRequest(String challengeToken, String code, String method, String origin) {
    public static MFAVerifyRequest of(String challengeToken, String code) {
        return new MFAVerifyRequest(challengeToken, code, "totp", null);
    }
}
