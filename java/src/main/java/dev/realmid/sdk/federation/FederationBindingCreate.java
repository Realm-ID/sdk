package dev.realmid.sdk.federation;

import java.util.List;
import java.util.Map;

/**
 * Create payload for {@link FederationBindingsClient#create} (ADR-057).
 * {@code issuer} must be an RI-known provider (v1: GCP
 * {@code accounts.google.com} or GitHub
 * {@code token.actions.githubusercontent.com}); {@code matchClaims} must
 * constrain at least the provider's mandatory claim. {@code audience} is forced
 * to the global RI constant server-side and cannot be set here.
 *
 * @param issuer      RI-known OIDC issuer.
 * @param matchClaims AND-conditions the assertion must satisfy.
 * @param mappedRole  role stamped on the minted session (defaults to
 *        {@code platform_api}); null omits it.
 * @param scope       optional scope list; null omits it.
 */
public record FederationBindingCreate(
        String issuer,
        Map<String, String> matchClaims,
        String mappedRole,
        List<String> scope) {

    public static FederationBindingCreate of(String issuer, Map<String, String> matchClaims) {
        return new FederationBindingCreate(issuer, matchClaims, null, null);
    }
}
