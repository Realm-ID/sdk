package dev.realmid.sdk.platformtoken;

/**
 * Supplies the bootstrap credential the SDK exchanges at {@code POST
 * /auth/login} (ADR-057). The static API key is one implementation; the
 * ambient cloud providers (GCP, GitHub Actions) are the others. {@code fetch}
 * is called only on initial login and refresh-death — never per request — so a
 * workload source may mint a fresh short-lived OIDC token there.
 */
@FunctionalInterface
public interface CredentialSource {
    Credential fetch();
}
