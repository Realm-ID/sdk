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
    private Map<String, UniqueKindReport> uniqueKindsReport = new LinkedHashMap<>();

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

    /**
     * Typed view of the realm's {@code phone_otp} config group (ADR-115; SPEC 6.5): how many phone
     * codes (SMS and WhatsApp together) one number may be sent per window. Default 5 per 900s;
     * RealmID's ceiling is 20 per 3600s. Written through the generic config PATCH, e.g.
     * {@code Map.of("phone_otp", Map.of("max_per_window", 8))} (a PATCH merges).
     *
     * <p>Empty means the issuer did not send it (an older issuer) or sent something unreadable;
     * it is never a zeroed object, which would invent a limit of 0.
     */
    public java.util.Optional<PhoneOtpConfig> phoneOtp() {
        if (!(config.get("phone_otp") instanceof Map<?, ?> m)) return java.util.Optional.empty();
        if (!(m.get("max_per_window") instanceof Number max) || !(m.get("window_seconds") instanceof Number win)) {
            return java.util.Optional.empty();
        }
        int perIp = m.get("sign_in_per_ip_per_hour") instanceof Number n ? n.intValue() : 0;
        return java.util.Optional.of(new PhoneOtpConfig(max.intValue(), win.intValue(), perIp));
    }

    /**
     * ADR-117: the contact kinds ({@code "email"}, {@code "phone"}) that identify a person in this
     * realm, read from {@code config.contacts.unique_kinds}. The issuer always sends the RESOLVED
     * list (an unset platform reads {@code [email, phone]}); an explicit empty list is legal and is
     * returned as a present, empty list. {@link java.util.Optional#empty()} means the issuer did not
     * send the key (an older issuer). Written through the generic config PATCH as
     * {@code Map.of("contacts", Map.of("unique_kinds", List.of("email")))}; a {@code 409
     * unique_kind_lockout} is escaped with {@code config().update(patch, true)}.
     */
    public java.util.Optional<java.util.List<String>> uniqueKinds() {
        if (!(config.get("contacts") instanceof Map<?, ?> c)) return java.util.Optional.empty();
        if (!(c.get("unique_kinds") instanceof java.util.List<?> l)) return java.util.Optional.empty();
        java.util.List<String> out = new java.util.ArrayList<>();
        for (Object o : l) out.add(String.valueOf(o));
        return java.util.Optional.of(java.util.List.copyOf(out));
    }

    /**
     * ADR-117, read-only: per contact kind, how many values are proven on more than one membership
     * of this platform. Counts only, never the values. Empty when the issuer omitted it (the count
     * could not be taken, or an older issuer): an empty map means "unknown", never "zero". It sits
     * BESIDE {@code config}, so PATCHing it answers {@code 400 unknown_config_key}.
     */
    public Map<String, UniqueKindReport> uniqueKindsReport() { return uniqueKindsReport; }

    /** One kind's entry of {@link #uniqueKindsReport()}. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record UniqueKindReport(
            @com.fasterxml.jackson.annotation.JsonProperty("values_on_multiple_memberships")
            int valuesOnMultipleMemberships) {}

    /**
     * The {@code phone_otp} config group as read (ADR-115). {@code signInPerIpPerHour} (ADR-116,
     * spec 0.61.0) is how many sign-in codes one end-user IP may request per hour (default 10,
     * range 1-60, cannot be turned off); 0 means the issuer did not send it (an older issuer).
     */
    public record PhoneOtpConfig(int maxPerWindow, int windowSeconds, int signInPerIpPerHour) {
        public PhoneOtpConfig(int maxPerWindow, int windowSeconds) {
            this(maxPerWindow, windowSeconds, 0);
        }
    }

    @com.fasterxml.jackson.annotation.JsonProperty("unique_kinds_report")
    @com.fasterxml.jackson.annotation.JsonAlias("uniqueKindsReport")
    public void setUniqueKindsReport(Map<String, UniqueKindReport> v) {
        this.uniqueKindsReport = v == null ? new LinkedHashMap<>() : v;
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
