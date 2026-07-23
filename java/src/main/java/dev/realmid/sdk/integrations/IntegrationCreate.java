package dev.realmid.sdk.integrations;

/**
 * POST body for {@code /platforms/{id}/integrations} (ADR-083 §4.1).
 *
 * <p>{@code slug} is 2-48 chars, lowercase alphanumerics and single hyphens,
 * unique per realm. {@code description}/{@code homepageUrl} are optional;
 * {@code listed} opts into a future discovery directory (deferred).
 */
public record IntegrationCreate(
        String slug,
        String displayName,
        String description,
        String homepageUrl,
        boolean listed) {

    public IntegrationCreate(String slug, String displayName) {
        this(slug, displayName, null, null, false);
    }
}
