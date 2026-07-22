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
    /**
     * ADR-076 WP4 invitation scope — the role names a holder of this role may
     * invite new members at. Inert unless the role also holds the
     * {@code invitations:manage} permission: the invite gate requires both.
     */
    @JsonProperty("can_invite_roles") @JsonAlias("canInviteRoles")
    private List<String> canInviteRoles = new ArrayList<>();
    /**
     * ADR-081 principal typing — the {@code users.kind} values
     * ({@code "human"} / {@code "service"}) that may hold this role. Since
     * ADR-081 &sect; Amendment 2 the server never stores this empty, so an empty
     * list means the response came from an issuer older than v0.57.0, where it
     * meant ANY — treat it that way. Read fails open; the server enforces on
     * write.
     */
    @JsonProperty("assignable_to") @JsonAlias("assignableTo")
    private List<String> assignableTo = new ArrayList<>();
    /**
     * ADR-081 &sect;2.5 — set ONLY on the {@link RolesClient#update} response of a
     * patch that narrowed {@code assignable_to} so humans may no longer hold
     * the role: its human holders were reassigned in the same transaction
     * rather than stranded. Null on every other response.
     */
    @JsonProperty("migrated_holders") @JsonAlias("migratedHolders")
    private Integer migratedHolders;
    /** The role those holders were migrated to. Non-null only with the count. */
    @JsonProperty("migrated_holders_to") @JsonAlias("migratedHoldersTo")
    private String migratedHoldersTo;
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
    public List<String> canInviteRoles() { return canInviteRoles; }
    public List<String> assignableTo() { return assignableTo; }
    public Integer migratedHolders() { return migratedHolders; }
    public String migratedHoldersTo() { return migratedHoldersTo; }
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
    public void setCanInviteRoles(List<String> v) { this.canInviteRoles = v; }
    public void setAssignableTo(List<String> v) { this.assignableTo = v; }
    public void setMigratedHolders(Integer v) { this.migratedHolders = v; }
    public void setMigratedHoldersTo(String v) { this.migratedHoldersTo = v; }
    public void setIsSystem(boolean v) { this.isSystem = v; }
    public void setDisabled(boolean v) { this.disabled = v; }
    public void setDisabledAt(long v) { this.disabledAt = v; }
    public void setCreatedAt(long v) { this.createdAt = v; }
    public void setUpdatedAt(long v) { this.updatedAt = v; }
}
