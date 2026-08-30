package dev.realmid.sdk.roles;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;

/**
 * One row of RealmID's role VOCABULARY (ADR-101 D1).
 *
 * <p>Not a role. A {@link RoleObject} belongs to one realm and has holders; a
 * template is the recipe a role is stamped from, and it belongs to RealmID.
 *
 * <p>{@code (level, name)} is the IDENTITY. The same name at both levels is two
 * different roles carrying different authority — a platform {@code admin} runs
 * a realm, a tenant {@code admin} runs one org — and collapsing them is the
 * ADR-090 bug class.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class RoleTemplate {

    private String id;
    private String level;
    private String name;
    @JsonProperty("display_name") @JsonAlias("displayName")
    private String displayName;
    /** ADR-074 catalog grants. Empty is meaningful — {@code member} is identity with no authority. */
    private List<String> permissions = new ArrayList<>();
    /** ADR-081 principal kinds. Never stored empty: an empty set is an unfinished row, not "any". */
    @JsonProperty("assignable_to") @JsonAlias("assignableTo")
    private List<String> assignableTo = new ArrayList<>();
    @JsonProperty("is_system") @JsonAlias("isSystem")
    private boolean system;
    /**
     * {@code false} means the template is part of the FLOOR every realm
     * receives, and creating it FANS OUT to realms that already exist.
     * {@code true} means it is created only when named.
     */
    private boolean optional;
    @JsonProperty("created_at") @JsonAlias("createdAt")
    private long createdAt;
    @JsonProperty("updated_at") @JsonAlias("updatedAt")
    private long updatedAt;

    public String id() { return id; }
    public String level() { return level; }
    public String name() { return name; }
    public String displayName() { return displayName; }
    public List<String> permissions() { return permissions; }
    public List<String> assignableTo() { return assignableTo; }
    public boolean isSystem() { return system; }
    public boolean isOptional() { return optional; }
    public long createdAt() { return createdAt; }
    public long updatedAt() { return updatedAt; }

    public void setId(String v) { this.id = v; }
    public void setLevel(String v) { this.level = v; }
    public void setName(String v) { this.name = v; }
    public void setDisplayName(String v) { this.displayName = v; }
    public void setPermissions(List<String> v) { this.permissions = v == null ? new ArrayList<>() : v; }
    public void setAssignableTo(List<String> v) { this.assignableTo = v == null ? new ArrayList<>() : v; }
    public void setSystem(boolean v) { this.system = v; }
    public void setOptional(boolean v) { this.optional = v; }
    public void setCreatedAt(long v) { this.createdAt = v; }
    public void setUpdatedAt(long v) { this.updatedAt = v; }
}
