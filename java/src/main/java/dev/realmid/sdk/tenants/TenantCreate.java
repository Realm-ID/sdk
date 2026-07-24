package dev.realmid.sdk.tenants;

import java.util.List;

/**
 * Create payload for {@code realm.tenants().create(...)} (SPEC §6.1, ADR-073
 * Amendment C).
 *
 * <p>The realm is implicit (the API key's realm); the wire call is
 * {@code POST /platforms/{realmId}/tenants} with body
 * {@code {id?, display_name, allowed_domains?, signup_mode?, created_at?, owner}}.
 * {@code signupMode} defaults to {@code "closed"} server-side (ADR-045).
 *
 * @param id             optional caller-supplied tenant UUID (ADR-073 C.1);
 *        absent → the server mints a UUIDv7. Exists in this realm → reconciles
 *        idempotently; exists in another realm → {@code cross_realm_tenant_id}.
 * @param displayName    the org's display name.
 * @param allowedDomains optional signup-domain allowlist.
 * @param signupMode     optional signup policy ({@code closed|allowlist|open}).
 * @param createdAt      optional RFC3339 creation timestamp (ADR-073 C.4);
 *        absent → server time. Ignored on reconcile.
 * @param owner          seats the org's owner in the same transaction. REQUIRED
 *        when creating a new tenant (server returns {@code owner_required}
 *        otherwise); may be omitted only on a pure reconcile of an
 *        already-owned tenant.
 */
public record TenantCreate(
        String id,
        String displayName,
        List<String> allowedDomains,
        String signupMode,
        String createdAt,
        TenantOwner owner) {

    /** New org with its owner (the common case). */
    public static TenantCreate of(String displayName, TenantOwner owner) {
        return new TenantCreate(null, displayName, null, null, null, owner);
    }

    /** New org with owner + a signup-domain allowlist. */
    public static TenantCreate of(String displayName, List<String> allowedDomains, TenantOwner owner) {
        return new TenantCreate(null, displayName, allowedDomains, null, null, owner);
    }

    /** New org with a caller-supplied id + owner (migration import). */
    public static TenantCreate withId(String id, String displayName, TenantOwner owner) {
        return new TenantCreate(id, displayName, null, null, null, owner);
    }

    /** Returns a copy of this payload with {@code createdAt} set. */
    public TenantCreate withCreatedAt(String createdAt) {
        return new TenantCreate(id, displayName, allowedDomains, signupMode, createdAt, owner);
    }
}
