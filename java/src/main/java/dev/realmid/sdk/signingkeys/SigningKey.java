package dev.realmid.sdk.signingkeys;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** One key in a realm's signing keyring (roles/signing-keys overhaul). */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class SigningKey {

    private String kid;
    @JsonProperty("created_at") @JsonAlias("createdAt")
    private long createdAt;
    @JsonProperty("active_until") @JsonAlias("activeUntil")
    private long activeUntil;
    @JsonProperty("retire_at") @JsonAlias("retireAt")
    private long retireAt;
    @JsonProperty("is_current") @JsonAlias("isCurrent")
    private boolean isCurrent;

    public SigningKey() {}

    /** The key id (JWKS {@code kid}). */
    public String kid() { return kid; }
    /** Unix-seconds timestamp the key was created. */
    public long createdAt() { return createdAt; }
    /** Unix-seconds timestamp the key stops signing new tokens. */
    public long activeUntil() { return activeUntil; }
    /** Unix-seconds timestamp the key drops out of the JWKS entirely. */
    public long retireAt() { return retireAt; }
    /** True for the key currently minting tokens. */
    public boolean isCurrent() { return isCurrent; }

    public void setKid(String v) { this.kid = v; }
    public void setCreatedAt(long v) { this.createdAt = v; }
    public void setActiveUntil(long v) { this.activeUntil = v; }
    public void setRetireAt(long v) { this.retireAt = v; }
    public void setIsCurrent(boolean v) { this.isCurrent = v; }
}
