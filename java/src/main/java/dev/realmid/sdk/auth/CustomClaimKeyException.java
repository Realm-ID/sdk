package dev.realmid.sdk.auth;

/**
 * YOUR {@link CustomClaimsHandler} returned a key the issuer would refuse (not printable ASCII, or
 * its ASCII fold equals a reserved claim name; SPEC §4.2 {@code SPEC4_2_claim_fold} rule 1). The
 * SDK refuses the mint first and names the key, since the handler is yours.
 */
public class CustomClaimKeyException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final String key;

    public CustomClaimKeyException(String key, String reason) {
        super("customClaims handler returned a refused key \"" + key + "\": " + reason);
        this.key = key;
    }

    public String key() { return key; }
}
