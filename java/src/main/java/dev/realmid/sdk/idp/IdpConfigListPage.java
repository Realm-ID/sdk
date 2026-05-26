package dev.realmid.sdk.idp;

import java.util.List;

/**
 * One page of {@code GET /identity-providers}. The server returns
 * {@code { "items": [IdpConfig] }}; an absent/nil {@code items} is
 * normalized to an empty list.
 */
public record IdpConfigListPage(List<IdpConfig> items) {
}
