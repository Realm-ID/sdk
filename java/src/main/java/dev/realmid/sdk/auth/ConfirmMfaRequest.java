package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#confirmMfa(ConfirmMfaRequest)}.
 *
 * <p>Current-user op (dual-mode bearer — see {@link EnrollMfaRequest}).
 * {@code code} (the TOTP) is required; {@code method} is optional and omitted
 * from the wire when null/empty.
 */
public record ConfirmMfaRequest(String userId, String userBearer, String onBehalfOfIp,
                                String code, String method) {

    /** BFF mode: confirm on behalf of {@code userId} with the given TOTP code. */
    public static ConfirmMfaRequest forUser(String userId, String code) {
        return new ConfirmMfaRequest(userId, null, null, code, null);
    }

    /** Legacy mode: confirm using the user's own access JWT and TOTP code. */
    public static ConfirmMfaRequest withBearer(String userBearer, String code) {
        return new ConfirmMfaRequest(null, userBearer, null, code, null);
    }
}
