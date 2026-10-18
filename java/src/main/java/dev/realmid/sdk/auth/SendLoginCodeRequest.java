package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#sendLoginCode(SendLoginCodeRequest)} (SPEC X.4a, issuer ADR-116).
 *
 * <p>{@code identifier} is a strict E.164 phone number. {@code deliveryMode} is {@code "sms"} or
 * {@code "whatsapp"} (required; no default, no fallback). {@code tenantId} is an optional hint;
 * send the same one to {@code otpLogin}. {@code onBehalfOfIp} is the END USER's IP, sent as
 * {@code X-On-Behalf-Of-IP}: without it only the per-phone limit applies; when set it must be a
 * parseable IPv4 or IPv6 address (else {@code 400 invalid_on_behalf_of_ip}).
 */
public record SendLoginCodeRequest(String identifier, String deliveryMode, String tenantId, String onBehalfOfIp) {

    public static SendLoginCodeRequest of(String identifier, String deliveryMode) {
        return new SendLoginCodeRequest(identifier, deliveryMode, null, null);
    }
}
