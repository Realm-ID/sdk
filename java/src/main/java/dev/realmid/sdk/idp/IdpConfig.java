package dev.realmid.sdk.idp;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonAnyGetter;
import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * One identity-provider config row (admin resource, distinct from the
 * realm's public IdP <em>discovery</em> surface).
 *
 * <p>Wire shape is snake_case; SDK accessors are camelCase.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class IdpConfig {

    private String id;
    @JsonProperty("entity_type") @JsonAlias("entityType")
    private String entityType;
    @JsonProperty("entity_id") @JsonAlias("entityId")
    private String entityId;
    private String provider;
    @JsonProperty("client_type") @JsonAlias("clientType")
    private String clientType;
    @JsonProperty("client_id") @JsonAlias("clientId")
    private String clientId;
    @JsonProperty("allowed_origins") @JsonAlias("allowedOrigins")
    private List<String> allowedOrigins = new ArrayList<>();
    private String comments;
    /**
     * Provider-specific PUBLIC config (never secrets) — e.g. the Firebase
     * web config (apiKey, authDomain, projectId, appId). Echoed verbatim on
     * public discovery. Null/absent when empty.
     */
    private Map<String, String> config;
    private boolean enabled;
    @JsonProperty("created_at") @JsonAlias("createdAt")
    private long createdAt;
    @JsonProperty("updated_at") @JsonAlias("updatedAt")
    private long updatedAt;
    private final Map<String, Object> extra = new HashMap<>();

    public IdpConfig() {}

    public String id() { return id; }
    public String entityType() { return entityType; }
    public String entityId() { return entityId; }
    public String provider() { return provider; }
    public String clientType() { return clientType; }
    public String clientId() { return clientId; }
    public List<String> allowedOrigins() { return allowedOrigins; }
    public String comments() { return comments; }
    public Map<String, String> config() { return config; }
    public boolean enabled() { return enabled; }
    public long createdAt() { return createdAt; }
    public long updatedAt() { return updatedAt; }
    @JsonAnyGetter public Map<String, Object> extra() { return extra; }
    @JsonAnySetter public void put(String k, Object v) { extra.put(k, v); }

    public void setId(String v) { this.id = v; }
    public void setEntityType(String v) { this.entityType = v; }
    public void setEntityId(String v) { this.entityId = v; }
    public void setProvider(String v) { this.provider = v; }
    public void setClientType(String v) { this.clientType = v; }
    public void setClientId(String v) { this.clientId = v; }
    public void setAllowedOrigins(List<String> v) { this.allowedOrigins = v; }
    public void setComments(String v) { this.comments = v; }
    public void setConfig(Map<String, String> v) { this.config = v; }
    public void setEnabled(boolean v) { this.enabled = v; }
    public void setCreatedAt(long v) { this.createdAt = v; }
    public void setUpdatedAt(long v) { this.updatedAt = v; }
}
