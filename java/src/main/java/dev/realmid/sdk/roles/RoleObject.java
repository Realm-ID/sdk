package dev.realmid.sdk.roles;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** One realm-defined role (ADR-040). */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class RoleObject {

    private String id;
    private String name;
    @JsonProperty("display_name") @JsonAlias("displayName")
    private String displayName;
    private List<String> permissions = new ArrayList<>();
    /**
     * ADR-075 per-role MFA method set — every holder must satisfy MFA via one
     * of these methods at login. Only {@code "totp"}/{@code "otp"} are accepted
     * server-side; empty means the role imposes no MFA requirement of its own.
     */
    @JsonProperty("required_mfa_methods") @JsonAlias("requiredMfaMethods")
    private List<String> requiredMfaMethods = new ArrayList<>();
    @JsonProperty("is_system") @JsonAlias("isSystem")
    private boolean isSystem;
    /**
     * Whether the role is soft-disabled: it stays in the catalog but is
     * hidden and no longer assignable. Toggle with {@link RolesClient#disable}
     * / {@link RolesClient#enable}. Absent on older servers (decodes to false).
     */
    @JsonProperty("disabled")
    private boolean disabled;
    /** Unix-seconds timestamp the role was disabled; 0 when active. */
    @JsonProperty("disabled_at") @JsonAlias("disabledAt")
    private long disabledAt;
    @JsonProperty("created_at") @JsonAlias("createdAt")
    private long createdAt;
    @JsonProperty("updated_at") @JsonAlias("updatedAt")
    private long updatedAt;
    private final Map<String, Object> extra = new HashMap<>();

    public RoleObject() {}

    public String id() { return id; }
    public String name() { return name; }
    public String displayName() { return displayName; }
    public List<String> permissions() { return permissions; }
    public List<String> requiredMfaMethods() { return requiredMfaMethods; }
    public boolean isSystem() { return isSystem; }
    public boolean disabled() { return disabled; }
    public long disabledAt() { return disabledAt; }
    public long createdAt() { return createdAt; }
    public long updatedAt() { return updatedAt; }
    @JsonAnyGetter public Map<String, Object> extra() { return extra; }
    @JsonAnySetter public void put(String k, Object v) { extra.put(k, v); }

    public void setId(String v) { this.id = v; }
    public void setName(String v) { this.name = v; }
    public void setDisplayName(String v) { this.displayName = v; }
    public void setPermissions(List<String> v) { this.permissions = v; }
    public void setRequiredMfaMethods(List<String> v) { this.requiredMfaMethods = v; }
    public void setIsSystem(boolean v) { this.isSystem = v; }
    public void setDisabled(boolean v) { this.disabled = v; }
    public void setDisabledAt(long v) { this.disabledAt = v; }
    public void setCreatedAt(long v) { this.createdAt = v; }
    public void setUpdatedAt(long v) { this.updatedAt = v; }
}
