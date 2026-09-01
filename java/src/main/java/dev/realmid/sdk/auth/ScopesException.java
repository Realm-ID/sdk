package dev.realmid.sdk.auth;

/**
 * Reports that YOUR {@link ScopesHandler} failed and the SDK therefore refused
 * to mint.
 *
 * <p><b>⚠️ Deliberately NOT a {@code RealmException}</b>, for the reason
 * {@link ProductRolesException} gives: "your scope handler failed 3 times" and
 * "RealmID refused your mint" are different incidents and must not look alike
 * in your logs — one is your database, the other is ours.
 *
 * <p>The refusal is the point, and it matters more here than it does for
 * {@code product_roles}. Minting anyway would put NO granted authority on the
 * token, which every gate reads as "denied" — so a transient blip in your role
 * store would become an authorization outage that our logs record as a clean
 * 200.
 */
public class ScopesException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String tenantId;
    private final String userId;
    private final int attempts;

    public ScopesException(String tenantId, String userId, int attempts, Throwable cause) {
        super("scopes handler failed after " + attempts + " attempts for tenant "
                + tenantId + ": " + cause, cause);
        this.tenantId = tenantId;
        this.userId = userId;
        this.attempts = attempts;
    }

    public String tenantId() { return tenantId; }

    public String userId() { return userId; }

    public int attempts() { return attempts; }
}
