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
        java.util.List<String> rolePermissions) {

    /** Pre-ADR-100 constructor; supplies no role permission list. */
    public TokenRequest(String refreshToken, String tenantId,
                        Map<String, Object> customClaims, String origin) {
        this(refreshToken, tenantId, customClaims, origin, null);
    }

    public static TokenRequest of(String refreshToken, String tenantId) {
        return new TokenRequest(refreshToken, tenantId, null, null, null);
    }

    public static TokenRequest withClaims(String refreshToken, String tenantId,
                                          Map<String, Object> customClaims) {
        return new TokenRequest(refreshToken, tenantId, customClaims, null, null);
    }

    /** Returns a copy carrying the ADR-100 role permission list. */
    public TokenRequest withRolePermissions(java.util.List<String> rolePermissions) {
        return new TokenRequest(refreshToken, tenantId, customClaims, origin, rolePermissions);
    }
}
