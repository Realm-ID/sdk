package dev.realmid.sdk.info;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * GET /platforms/{id}/config body: the realm id plus its configuration.
 *
 * <p>{@code config} is deliberately an untyped {@code Map}, mirroring the
 * untyped patch on the write side: the key set is server-owned (the issuer
 * derives it by reflection from its {@code RealmConfigPatch} and drift-tests it
 * there), so a hand-maintained POJO here would go stale the moment a key is
 * added and would silently drop it.
 *
 * <p>Server conventions (issuer {@code realm.ConfigView}):
 * <ul>
 *   <li>every allowlist key is ALWAYS present; the zero value means "unset"
 *       (0 for numbers, {@code ""} for strings, {@code false} for booleans),</li>
 *   <li>{@code access_token_custom_claim_keys} is always a list, never null,</li>
 *   <li>{@code refresh_absolute_expiry} is always the full object
 *       {@code {mode ("rolling" when unset), daily_cutoff_local, timezone,
 *       applies_to_service}}.</li>
 * </ul>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class RealmConfigResponse {

    private String id;
    private Map<String, Object> config = new LinkedHashMap<>();
    private Integer singleTenantPendingReconciliation;

    public RealmConfigResponse() {}

    /** The realm (platform) id the config belongs to. */
    public String id() { return id; }
    /** The mutable-config key set; see this class's doc for conventions. */
    public Map<String, Object> config() { return config; }

    /**
     * ADR-092 D4 — how many people in this realm still hold 2+ ACTIVE
     * memberships while {@code single_tenant_membership} is on. It sits BESIDE
     * {@code config}, not inside it, precisely because it is DERIVED, read-only
     * state; putting it in the settings bag would imply it is settable, and
     * PATCHing it answers {@code 400 unknown_config_key}.
     *
     * <p>{@code null} means the rule is off (the issuer reports the number only
     * while it is on); {@code 0} means on and fully drained. Turning the rule
     * on is allowed with violations outstanding — the D5 picker drains them at
     * each next login, so a user who never logs in never resolves and this
     * number is how an admin sees that.
     */
    public Integer singleTenantPendingReconciliation() {
        return singleTenantPendingReconciliation;
    }

    public void setId(String v) { this.id = v; }
    public void setConfig(Map<String, Object> v) {
        this.config = v == null ? new LinkedHashMap<>() : v;
    }
    @com.fasterxml.jackson.annotation.JsonProperty("single_tenant_pending_reconciliation")
    @com.fasterxml.jackson.annotation.JsonAlias("singleTenantPendingReconciliation")
    public void setSingleTenantPendingReconciliation(Integer v) {
        this.singleTenantPendingReconciliation = v;
    }
}
