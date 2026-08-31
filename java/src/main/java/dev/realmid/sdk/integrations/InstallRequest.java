package dev.realmid.sdk.integrations;

import java.util.List;

/**
 * POST body for {@code /tenants/{id}/integration-installations} (ADR-083 §4.2).
 *
 * <p>{@code permissions} is the ADR-101 D7 STATED grant: the ADR-074 catalog
 * permissions this integration may exercise in the target org. It replaced
 * {@code roleId}, which named a role and silently inherited whatever that role
 * granted today.
 *
 * <p>Required and non-empty — an install granting nothing can authorise no
 * call, and ADR-100's lesson is that an empty authority field acquires a
 * meaning nobody chose. Empty is {@code 400 permissions_required}, not an
 * install that enforces nothing. Every entry must be a real catalog permission
 * ({@code 400 unknown_permission}), and you cannot grant authority you do not
 * hold ({@code 403 permissions_exceed_grantor} — the tenant owner is
 * implicit-all and never sees it).
 *
 * <p><strong>Breaking change:</strong> the component list changed, so the
 * positional constructor arity/types changed with it — {@code new
 * InstallRequest(id, roleId)} becomes {@code new InstallRequest(id,
 * List.of("users:read"))}.
 */
public record InstallRequest(String integrationId, List<String> permissions) {
}
