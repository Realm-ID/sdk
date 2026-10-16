package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#redeemRecoveryCode(RedeemRecoveryCodeRequest)}
 * (SPEC §4.3a, {@code POST /auth/mfa/recovery}).
 *
 * <p>{@code challengeToken} is the {@code mfa_challenge_token} the MFA gate
 * minted; the code alone is useless without it. {@code refreshToken} is optional
 * and has the meaning documented on {@link MFAVerifyRequest}.
 */
public record RedeemRecoveryCodeRequest(String challengeToken, String code, String origin, String refreshToken) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "RedeemRecoveryCodeRequest[origin=" + origin + "]";
    }


    public static RedeemRecoveryCodeRequest of(String challengeToken, String code) {
        return new RedeemRecoveryCodeRequest(challengeToken, code, null, null);
    }

    /** A copy that runs under the per-session lock keyed on {@code refreshToken}. */
    public RedeemRecoveryCodeRequest withRefreshToken(String refreshToken) {
        return new RedeemRecoveryCodeRequest(challengeToken, code, origin, refreshToken);
    }
}
