package dev.realmid.sdk.auth;

import java.util.Map;

/**
 * SPEC §4.2 — refresh-token rotation, tenant switch, and custom claim
 * injection on the minted access token.
 */
public record TokenRequest(
        String refreshToken,
        String tenantId,
        Map<String, Object> customClaims,
        String origin,
        /**
         * ADR-100 D16/D5 — the permissions the holder's ROLE confers, in YOUR
         * vocabulary, used to narrow a user-API-key token's {@code permissions_cap}
         * claim to this org — on REFRESH as well as login (D18).
         *
         * <p>Supply it on EVERY mint. A user-API-key session IS refreshable, so a
         * refresh that omits the list comes back WIDER than the token it replaces,
         * silently. Supply it from your own role→permission map. RealmID stores no partner
         * catalog and will not resolve it for you (D17): a scope string is opaque here.
         *
         * <p><b>Optional, and omitting it can only widen TOWARD the stored cap, never
         * past it.</b> The claim minted is {@code stored_cap ∩ rolePermissions}; omit
         * the field and the stored cap travels unnarrowed, which is exactly the
         * pre-ADR-100 behaviour. A wrong or hostile list therefore cannot widen a key —
         * {@code A ∩ B ⊆ A} for every {@code B} — which is what makes a caller-asserted
         * value acceptable at all. It is audited as ASSERTED and unverified, the same
         * convention {@code source_org_id} uses.
         *
         * <p>Ignored for a token that is not key-derived, and ignored for an UNCAPPED
         * key, whose claim stays ABSENT whatever you send (D7).
         *
         * <p><b>⚠️ An empty INTERSECTION is 403, not an empty claim</b> (D8), and the
         * narrowing is per-org — so a multi-org key can mint in one org and be refused
         * in another. The error names the org.
         */
        java.util.List<String> rolePermissions,
        /**
         * ADR-097 GRANTED AUTHORITY — the partner's OWN scope strings, minted
         * into the token's {@code scope} claim and read back by
         * {@link dev.realmid.sdk.scope.Scopes} / {@code ScopePolicy} /
         * {@code ScopeFilter}.
         *
         * <p>This is the operand the enforcement layer evaluates. Supply it from
         * YOUR role&rarr;scope map: RealmID stores no partner catalog (ADR-097
         * D17) and a scope string is opaque there — shape is validated, meaning
         * never is.
         *
         * <p>A LIST, not the wire's space-delimited string, on purpose. The SDK
         * joins with {@code " "} and refuses an entry that could not survive it,
         * because a space inside one entry is not a parse error on the wire — it
         * SPLITS one scope into two and mints authority you did not ask for. An
         * unsendable entry is a {@code RealmException(BAD_REQUEST)} raised before
         * the request leaves.
         *
         * <p>Accepted on {@code /auth/token} ONLY, never on {@code /auth/login}:
         * the ADR-041 escort runs on this route for every refresh class, so a
         * confidential backend is structurally always in the path and a user
         * cannot self-assert a scope.
         *
         * <p><b>Optional. Empty and absent are the same request</b> — unlike
         * {@code rolePermissions}, an empty scope carries no instruction. The
         * issuer bounds the list against the realm's
         * {@code user_api_keys.max_permission_strings} /
         * {@code max_permission_string_len} ({@code 400 too_many_scopes} /
         * {@code scope_too_long}) and refuses it outright on a service-class
         * refresh ({@code 400 scope_not_supported}).
         *
         * <p>Where the token is ALSO user-API-key-derived, the minted claim is
         * the intersection with {@code permissions_cap}; see
         * {@code rolePermissions} for that narrowing.
         */
        java.util.List<String> scope,
        /**
         * ADR-102 — the PARTNER's own role name(s) for this principal, carried
         * onto the access token and read by no RealmID gate.
         *
         * <p>Normally you do NOT set this by hand: register a
         * {@link ProductRolesHandler} on the realm builder and
         * {@code login}/{@code completeLogin} populate it on every mint. The
         * field is here because the mint accepts it.
         *
         * <p><b>⚠️ {@code scope} carries authority; this carries a NAME.</b> Do
         * not branch authorization on it, and do not confuse it with the
         * {@code role} claim, which is RealmID's OWN vocabulary and a trusted
         * authorization lookup key on the direct-bearer lane.
         *
         * <p>Bounded by CONSTANTS, not realm config: at most 16 entries of at
         * most 64 bytes, each non-empty, valid UTF-8 and free of control
         * characters. An empty list mints no claim rather than {@code []}.
         */
        java.util.List<String> productRoles) {

    /** Pre-ADR-102 constructor; supplies no product roles. */
    public TokenRequest(String refreshToken, String tenantId,
                        Map<String, Object> customClaims, String origin,
                        java.util.List<String> rolePermissions, java.util.List<String> scope) {
        this(refreshToken, tenantId, customClaims, origin, rolePermissions, scope, null);
    }

    /** Pre-ADR-097-mint constructor; supplies no scope. */
    public TokenRequest(String refreshToken, String tenantId,
                        Map<String, Object> customClaims, String origin,
                        java.util.List<String> rolePermissions) {
        this(refreshToken, tenantId, customClaims, origin, rolePermissions, null, null);
    }

    /** Pre-ADR-100 constructor; supplies no role permission list. */
    public TokenRequest(String refreshToken, String tenantId,
                        Map<String, Object> customClaims, String origin) {
        this(refreshToken, tenantId, customClaims, origin, null, null, null);
    }

    public static TokenRequest of(String refreshToken, String tenantId) {
        return new TokenRequest(refreshToken, tenantId, null, null, null, null, null);
    }

    public static TokenRequest withClaims(String refreshToken, String tenantId,
                                          Map<String, Object> customClaims) {
        return new TokenRequest(refreshToken, tenantId, customClaims, null, null, null, null);
    }

    /** Returns a copy carrying the ADR-100 role permission list. */
    public TokenRequest withRolePermissions(java.util.List<String> rolePermissions) {
        // The CANONICAL constructor, deliberately — a shorter compat form
        // compiles here just as well and would silently drop `scope` and
        // `productRoles`. That trap is why every `with*` below names all of them.
        return new TokenRequest(refreshToken, tenantId, customClaims, origin,
                rolePermissions, scope, productRoles);
    }

    /** Returns a copy carrying the ADR-097 granted-authority scope list. */
    public TokenRequest withScope(java.util.List<String> scope) {
        return new TokenRequest(refreshToken, tenantId, customClaims, origin,
                rolePermissions, scope, productRoles);
    }

    /** Returns a copy carrying the ADR-102 partner role names. */
    public TokenRequest withProductRoles(java.util.List<String> productRoles) {
        return new TokenRequest(refreshToken, tenantId, customClaims, origin,
                rolePermissions, scope, productRoles);
    }
}
