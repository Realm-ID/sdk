package dev.realmid.sdk.auth;

/**
 * SPEC §4.1 — provider token exchange. {@code customClaims} are intentionally
 * not accepted on login; use {@link TokenRequest#customClaims()} on refresh.
 *
 * <p>{@code deviceName} (ADR-062) is a human-readable label for the device this
 * login happens on (a CLI hostname, a browser name). It travels as the
 * {@code X-Device-Name} header — never in the body — and the issuer persists it
 * on the created session so a user can tell their sessions apart when revoking
 * one ({@code GET /auth/sessions} → {@link Session#deviceName()}). The server
 * strips control characters and caps it at 120 characters, so no client-side
 * sanitizing is duplicated here.
 */
public record LoginRequest(
        String method,
        String providerToken,
        String origin,
        String deviceName,
        /**
         * ADR-100 D16/D5 — the permissions the holder's ROLE confers, in YOUR
         * vocabulary, used to narrow a user-API-key token's {@code permissions_cap}
         * claim to this org.
         *
         * <p>Supply it from your own role→permission map. RealmID stores no partner
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
    public LoginRequest(String method, String providerToken, String origin, String deviceName) {
        this(method, providerToken, origin, deviceName, null);
    }

    /** Pre-ADR-062 constructor; records no device label. */
    public LoginRequest(String method, String providerToken, String origin) {
        this(method, providerToken, origin, null, null);
    }

    public static LoginRequest of(String method, String providerToken) {
        return new LoginRequest(method, providerToken, null, null, null);
    }

    /** Returns a copy carrying the ADR-062 device label. */
    public LoginRequest withDeviceName(String deviceName) {
        return new LoginRequest(method, providerToken, origin, deviceName, rolePermissions);
    }

    /** Returns a copy carrying the ADR-100 role permission list. */
    public LoginRequest withRolePermissions(java.util.List<String> rolePermissions) {
        return new LoginRequest(method, providerToken, origin, deviceName, rolePermissions);
    }
}
