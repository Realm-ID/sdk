package dev.realmid.sdk.auth;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

/**
 * Login / mfa-verify response (SPEC §4). Also doubles as the session record
 * returned by {@code listSessions} (sessions may have only id/createdAt).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record Session(
        @JsonProperty("access_token") @JsonAlias("accessToken") String accessToken,
        @JsonProperty("refresh_token") @JsonAlias("refreshToken") String refreshToken,
        @JsonProperty("expires_in") @JsonAlias("expiresIn") long expiresIn,
        // SPEC §4.1 — absolute wall-clock expiry (unix seconds) of the returned
        // refresh token, past which it can no longer be rotated. 0 when the
        // issuer does not surface it (pre-refresh_exp issuers); callers that
        // size a session from it must fall back to their own ceiling.
        @JsonProperty("refresh_exp") @JsonAlias("refreshExp") long refreshExp,
        // ADR-070 — sliding-window idle-timeout duration (seconds). Each
        // authenticated use slides the window forward by idleTtl; 0 (absent)
        // means no idle timeout — treat as "disabled", not "expire now".
        @JsonProperty("idle_ttl") @JsonAlias("idleTtl") long idleTtl,
        @JsonProperty("expires_at") @JsonAlias("expiresAt") String expiresAt,
        // ADR-071 §8 — the owner/admin who minted the login OTP that produced
        // this service-account session (attribution/provenance). null for
        // human/provider logins and M2M sessions. Decoded from the issuer's
        // `initiated_by_user_id`.
        @JsonProperty("initiated_by_user_id") @JsonAlias("initiatedByUserId") String initiatedByUserId,
        Map<String, Object> user,
        List<TenantRef> tenants,
        String id,
        @JsonProperty("created_at") @JsonAlias("createdAt") String createdAt,
        // Wire field is `last_seen_at` (issuer httpapi.sessionDTO.LastSeenAt),
        // NOT `last_used_at`. The accessor keeps the lastUsedAt() name for API
        // stability and cross-language parity (Go SessionInfo.LastUsedAt).
        // Before this fix the property read `last_used_at`, so lastUsedAt()
        // always deserialized to null.
        @JsonProperty("last_seen_at") @JsonAlias({"lastSeenAt", "last_used_at", "lastUsedAt"}) String lastUsedAt,
        @JsonProperty("user_agent") @JsonAlias("userAgent") String userAgent,
        String ip,
        // ADR-062 — the human-readable device label supplied at login via the
        // X-Device-Name header (e.g. a CLI hostname), so a user can tell their
        // sessions apart before revoking one. null when the session was created
        // without one, and on every M2M session. Parity: Go
        // SessionInfo.DeviceName, TS SessionInfo.device_name.
        @JsonProperty("device_name") @JsonAlias("deviceName") String deviceName,
        // ADR-092 D5 — the caller holds more than one ACTIVE membership in a
        // realm that requires single-tenant membership and must give the
        // extras up. The login SUCCEEDED (access + refresh tokens are present),
        // so this is a reconciliation prompt, not an auth failure: refusing the
        // login would strand exactly the users the drain exists to resolve.
        // Settle it with realm.me().chooseTenant(...). false on every realm
        // with the knob off, which is every realm until a partner turns it on.
        @JsonProperty("tenant_choice_required") @JsonAlias("tenantChoiceRequired")
        boolean tenantChoiceRequired,
        // The memberships the D5 picker may choose between; null when absent.
        @JsonProperty("tenant_choices") @JsonAlias("tenantChoices")
        List<TenantChoice> tenantChoices,
        // ADR-102 D10 — the tenant this session resolved to, once settled.
        // null on the multi-tenant branch until completeLogin runs.
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        // The caller's role in tenantId.
        String role
) {

    /**
     * Reports whether the issuer returned a tenant PICKER instead of a session:
     * more than one membership and no access token minted (ADR-102 D10).
     *
     * <p><b>⚠️ Ported from Go's {@code Session.NeedsTenantChoice}.</b> It had no
     * Java or TS equivalent, which is exactly the surface D10 depends on — a
     * hand-mirrored surface with a hole in it is how the hole survived.
     *
     * <p>Unrelated to {@link #tenantChoiceRequired()} (ADR-092 D5), which is a
     * single-tenant-membership RECONCILIATION prompt on a login that already
     * SUCCEEDED. Same words, different mechanism; do not conflate them.
     */
    public boolean needsTenantChoice() {
        return (accessToken == null || accessToken.isEmpty())
                && tenants != null && tenants.size() > 1;
    }

    /**
     * Resolves the final {@code (tenantId, role)} pair to persist, given an
     * optional caller preference. Order: preferred &gt; {@link #tenantId()} &gt;
     * {@code tenants().get(0)}.
     *
     * <p><b>⚠️ DO NOT use this to settle the D10 multi-tenant branch.</b> The
     * {@code tenants[0]} fallback would mint for an ARBITRARY tenant and resolve
     * THAT tenant's product roles — a silent wrong answer, not an error. This is
     * for a caller that has already decided;
     * {@code AuthClient.completeLogin} is the selection mechanism.
     *
     * <p>Ported from Go's {@code Session.SelectTenant}.
     */
    public TenantSelection selectTenant(String preferred) {
        String tid = (preferred != null && !preferred.isEmpty()) ? preferred : tenantId;
        if ((tid == null || tid.isEmpty()) && tenants != null && !tenants.isEmpty()) {
            tid = tenants.get(0).id();
        }
        String r = role;
        if (tenants != null) {
            for (TenantRef t : tenants) {
                if (t.id() != null && t.id().equals(tid)) {
                    r = t.role();
                    break;
                }
            }
        }
        return new TenantSelection(tid, r);
    }

    /** The resolved pair returned by {@link #selectTenant(String)}. */
    public record TenantSelection(String tenantId, String role) {}

    /**
     * Returns a copy carrying a freshly minted token pair and the settled tenant
     * (ADR-102 D10).
     *
     * <p>A record cannot be updated in place, so the Java shape of D10 returns a
     * NEW session where Go and TS mutate one. The contract is identical; only the
     * idiom differs.
     */
    public Session withMint(TokenResponse mint, String settledTenantId) {
        String r = role;
        if (tenants != null) {
            for (TenantRef t : tenants) {
                if (t.id() != null && t.id().equals(settledTenantId)) {
                    r = t.role();
                    break;
                }
            }
        }
        return new Session(
                mint.accessToken(), mint.refreshToken(), mint.expiresIn(),
                mint.refreshExp() != 0 ? mint.refreshExp() : refreshExp,
                idleTtl, expiresAt, initiatedByUserId, user, tenants, id, createdAt,
                lastUsedAt, userAgent, ip, deviceName,
                tenantChoiceRequired, tenantChoices, settledTenantId, r);
    }
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TenantRef(
            // The wire field is `tenant_id`; `id` is accepted as a fallback for
            // older and mocked issuers, matching Go's TenantRef.IDLegacy.
            @JsonProperty("tenant_id") @JsonAlias({"tenantId", "id"}) String id,
            String role,
            @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
            /**
             * Whether this membership demands an MFA step before a usable access
             * token is minted. A BFF uses it to tell an unminted-because-MFA
             * login apart from an unminted-because-multi-tenant one.
             *
             * <p><b>⚠️ Ported from Go as part of ADR-102 D10.</b> It existed only
             * in the Go SDK; D10's multi-tenant branch depends on being able to
             * tell those two states apart, so closing the parity gap is a
             * prerequisite, not a tidy-up.
             */
            @JsonProperty("mfa_required") @JsonAlias("mfaRequired") boolean mfaRequired) {}

    /** One option in the ADR-092 D5 single-tenant picker. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record TenantChoice(
            @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
            @JsonProperty("display_name") @JsonAlias("displayName") String displayName,
            // Marks a membership that CANNOT be given up: releasing it would
            // leave the tenant ownerless and `tenants.owner_user_id` is NOT
            // NULL. Do not offer it — the server refuses it regardless — the
            // way out is an ADR-076 ownership transfer first.
            @JsonProperty("is_owner") @JsonAlias("isOwner") boolean isOwner) {}
}
