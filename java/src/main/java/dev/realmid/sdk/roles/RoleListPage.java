package dev.realmid.sdk.roles;

import java.util.List;

/**
 * One page of {@code GET /platforms/{id}/roles} in the locked SPEC §7
 * envelope shape. {@code nextCursor} is null when there are no more
 * pages; {@code total} is null when the server omits it.
 */
public record RoleListPage(List<RoleObject> items, String nextCursor, Long total) {
}
