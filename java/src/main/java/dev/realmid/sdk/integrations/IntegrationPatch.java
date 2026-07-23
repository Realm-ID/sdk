package dev.realmid.sdk.integrations;

/**
 * PATCH body for {@code /platforms/{id}/integrations/{iid}}. Null fields are
 * left untouched (PATCH semantics).
 */
public record IntegrationPatch(
        String displayName,
        String description,
        String homepageUrl,
        Boolean listed) {
}
