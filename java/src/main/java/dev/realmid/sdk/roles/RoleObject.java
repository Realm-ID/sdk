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
    @JsonProperty("is_system") @JsonAlias("isSystem")
    private boolean isSystem;
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
    public boolean isSystem() { return isSystem; }
    public long createdAt() { return createdAt; }
    public long updatedAt() { return updatedAt; }
    @JsonAnyGetter public Map<String, Object> extra() { return extra; }
    @JsonAnySetter public void put(String k, Object v) { extra.put(k, v); }

    public void setId(String v) { this.id = v; }
    public void setName(String v) { this.name = v; }
    public void setDisplayName(String v) { this.displayName = v; }
    public void setPermissions(List<String> v) { this.permissions = v; }
    public void setIsSystem(boolean v) { this.isSystem = v; }
    public void setCreatedAt(long v) { this.createdAt = v; }
    public void setUpdatedAt(long v) { this.updatedAt = v; }
}
