package dev.realmid.sdk.auth;

/**
 * Reports that YOUR {@link ProductRolesHandler} failed and the SDK therefore
 * refused to mint (ADR-102 D11 rule 3).
 *
 * <p><b>⚠️ Deliberately NOT a {@code RealmException}.</b> "Your role handler
 * failed 3 times" and "RealmID refused your mint" are different incidents and
 * must not look alike in your logs — one is your database, the other is ours.
 *
 * <p>The refusal is the point. Minting anyway would put "this principal has no
 * product roles" on the token, which is indistinguishable from the truth for a
 * principal who genuinely has none — a silent under-grant that surfaces as a
 * mysterious 403 storm in YOUR product, with a 200 in our logs. The same rule
 * ADR-097 D3 applied to a dropped claim.
 */
public class ProductRolesException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String tenantId;
    private final String userId;
    private final int attempts;

    public ProductRolesException(String tenantId, String userId, int attempts, Throwable cause) {
        super("product_roles handler failed after " + attempts + " attempts for tenant "
                + tenantId + ": " + cause, cause);
        this.tenantId = tenantId;
        this.userId = userId;
        this.attempts = attempts;
    }

    public String tenantId() { return tenantId; }

    public String userId() { return userId; }

    public int attempts() { return attempts; }
}
