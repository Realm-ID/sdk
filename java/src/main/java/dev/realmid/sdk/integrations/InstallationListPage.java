package dev.realmid.sdk.integrations;

import java.util.List;

/** One page of {@code GET /tenants/{id}/integration-installations} (SPEC §7). */
public record InstallationListPage(List<Installation> items, String nextCursor) {
}
