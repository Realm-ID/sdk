package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#mfaVerifyOtp(MfaVerifyOtpRequest)} (SPEC §X.5 —
 * partner OTP second-factor verify).
 *
 * <p>{@code mfaToken} is the {@code mfa_challenge_token} from a prior
 * {@code /auth/login} response; {@code presented} is the OTP value the user
 * typed. {@code origin} is optional.
 */
public record MfaVerifyOtpRequest(String mfaToken, String presented, String origin) {

    public static MfaVerifyOtpRequest of(String mfaToken, String presented) {
        return new MfaVerifyOtpRequest(mfaToken, presented, null);
    }
}
