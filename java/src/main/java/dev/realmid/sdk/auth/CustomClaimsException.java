package dev.realmid.sdk.auth;

/**
 * YOUR {@link CustomClaimsHandler} failed and the SDK refused to mint (SPEC §10.2 rule 3).
 * Deliberately NOT a {@code RealmException}: it is your store failing, not RealmID refusing.
 * Minting without the claims would under-grant silently.
 */
public class CustomClaimsException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String tenantId;
    private final String userId;
    private final int attempts;

    public CustomClaimsException(String tenantId, String userId, int attempts, Throwable cause) {
        super("customClaims handler failed after " + attempts + " attempts for tenant "
                + tenantId + ": " + cause, cause);
        this.tenantId = tenantId;
        this.userId = userId;
        this.attempts = attempts;
    }

    public String tenantId() { return tenantId; }

    public String userId() { return userId; }

    public int attempts() { return attempts; }
}
