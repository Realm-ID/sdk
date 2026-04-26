package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.HashMap;
import java.util.Map;

@JsonIgnoreProperties(ignoreUnknown = true)
public final class Tenant {
    private String id;
    @JsonProperty("display_name") @JsonAlias("displayName")
    private String displayName;
    @JsonProperty("owner_user_id") @JsonAlias("ownerUserId")
    private String ownerUserId;
    private Map<String, Object> config;
    @JsonProperty("created_at") @JsonAlias("createdAt")
    private String createdAt;
    @JsonProperty("updated_at") @JsonAlias("updatedAt")
    private String updatedAt;
    private final Map<String, Object> extra = new HashMap<>();

    public Tenant() {}

    public String id() { return id; }
    public String displayName() { return displayName; }
    public String ownerUserId() { return ownerUserId; }
    public Map<String, Object> config() { return config; }
    public String createdAt() { return createdAt; }
    public String updatedAt() { return updatedAt; }
    @JsonAnyGetter public Map<String, Object> extra() { return extra; }
    @JsonAnySetter public void put(String k, Object v) { extra.put(k, v); }

    public void setId(String v) { this.id = v; }
    public void setDisplayName(String v) { this.displayName = v; }
    public void setOwnerUserId(String v) { this.ownerUserId = v; }
    public void setConfig(Map<String, Object> v) { this.config = v; }
    public void setCreatedAt(String v) { this.createdAt = v; }
    public void setUpdatedAt(String v) { this.updatedAt = v; }
}
