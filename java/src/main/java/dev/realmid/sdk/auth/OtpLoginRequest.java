package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#otpLogin(OtpLoginRequest)} (SPEC §X.4 —
 * partner OTP single-factor login).
 *
 * <p>{@code identifier} is an E.164 phone or email scoped to the realm;
 * {@code presented} is the manager-issued OTP value the user typed.
 * {@code tenantId} and {@code origin} are optional.
 */
public record OtpLoginRequest(String identifier, String presented, String tenantId, String origin) {

    public static OtpLoginRequest of(String identifier, String presented) {
        return new OtpLoginRequest(identifier, presented, null, null);
    }
}
