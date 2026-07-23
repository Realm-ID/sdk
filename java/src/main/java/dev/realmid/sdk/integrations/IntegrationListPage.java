package dev.realmid.sdk.integrations;

import java.util.List;

/** One page of {@code GET /platforms/{id}/integrations} (locked SPEC §7). */
public record IntegrationListPage(List<Integration> items, String nextCursor) {
}
