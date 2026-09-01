package dev.realmid.sdk.auth;

/**
 * Request for {@link AuthClient#passwordLogin(PasswordLoginRequest)} —
 * ADR-104's native username/password grant.
 *
 * <p>{@code identifier} is an email, an E.164 phone, or a USERNAME. The issuer
 * CLASSIFIES IT ONCE, never trying several kinds in turn: a fallthrough would
 * let a string valid as two kinds resolve differently depending on which store
 * answered first — a nondeterministic identity. The three grammars are disjoint
 * by construction.
 *
 * <p><b>⚠️ {@code tenantId} is optional for an email or phone and LOAD-BEARING
 * for a username.</b> Usernames are unique per TENANT, not per realm —
 * {@code alice} in two orgs is routinely two people — so the issuer resolves
 * the tenant as: this field if present, else the tenant bound to the request's
 * host. <b>Explicit wins</b>, including when the two disagree: a partner BFF is
 * server-side and its Origin is its own, not the end user's org, so an
 * Origin-wins rule would make BFF-fronted username login unimplementable
 * without one host per org.
 *
 * <p>Neither source yielding one is {@code 400 tenant_required} — a NAMED code,
 * not a credential failure, because it is an integration mistake rather than a
 * wrong password. The SDK does NOT guess a tenant.
 */
public record PasswordLoginRequest(String identifier, String presented,
                                   String tenantId, String origin) {

    public static PasswordLoginRequest of(String identifier, String presented) {
        return new PasswordLoginRequest(identifier, presented, null, null);
    }

    public static PasswordLoginRequest inTenant(String identifier, String presented,
                                                String tenantId) {
        return new PasswordLoginRequest(identifier, presented, tenantId, null);
    }
}
