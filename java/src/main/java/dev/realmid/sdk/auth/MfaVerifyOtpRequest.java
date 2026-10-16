package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#mfaVerifyOtp(MfaVerifyOtpRequest)} (SPEC §X.5 —
 * partner OTP second-factor verify).
 *
 * <p>{@code mfaToken} is the {@code mfa_challenge_token} from a prior
 * {@code /auth/login} response; {@code presented} is the OTP value the user
 * typed. {@code origin} is optional. {@code refreshToken} is optional and has
 * the meaning documented on {@link MFAVerifyRequest} (SPEC §4.3, go 0.64.2).
 */
public record MfaVerifyOtpRequest(String mfaToken, String presented, String origin, String refreshToken) {

    public MfaVerifyOtpRequest(String mfaToken, String presented, String origin) {
        this(mfaToken, presented, origin, null);
    }

    public static MfaVerifyOtpRequest of(String mfaToken, String presented) {
        return new MfaVerifyOtpRequest(mfaToken, presented, null, null);
    }

    /** A copy that runs under the per-session lock keyed on {@code refreshToken}. */
    public MfaVerifyOtpRequest withRefreshToken(String refreshToken) {
        return new MfaVerifyOtpRequest(mfaToken, presented, origin, refreshToken);
    }
}
