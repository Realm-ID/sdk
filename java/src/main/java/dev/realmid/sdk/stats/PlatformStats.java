package dev.realmid.sdk.stats;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** GET /platforms/{pid}/stats body — the platform KPI rollup. */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class PlatformStats {

    @JsonProperty("platform_id") @JsonAlias("platformId")
    private String platformId;
    @JsonProperty("generated_at") @JsonAlias("generatedAt")
    private long generatedAt;
    @JsonProperty("orgs_count") @JsonAlias("orgsCount")
    private int orgsCount;
    @JsonProperty("users_count") @JsonAlias("usersCount")
    private int usersCount;
    @JsonProperty("sessions_24h") @JsonAlias("sessions24h")
    private int sessions24h;
    @JsonProperty("mfa_coverage") @JsonAlias("mfaCoverage")
    private MfaCoverage mfaCoverage = new MfaCoverage();

    public PlatformStats() {}

    /** The platform (realm) id the rollup describes. */
    public String platformId() { return platformId; }
    /**
     * Unix-seconds timestamp the snapshot was computed; may lag "now" by up to
     * the server's 30-second cache window.
     */
    public long generatedAt() { return generatedAt; }
    /** Organizations (tenants) in the platform. */
    public int orgsCount() { return orgsCount; }
    /** Total user population. */
    public int usersCount() { return usersCount; }
    /**
     * {@code class="user"} sessions CREATED in the trailing 24 hours — human
     * sign-ins, not tokens minted and not sessions still alive.
     */
    public int sessions24h() { return sessions24h; }
    /** MFA-enrollment coverage of the eligible population. */
    public MfaCoverage mfaCoverage() { return mfaCoverage; }

    public void setPlatformId(String v) { this.platformId = v; }
    public void setGeneratedAt(long v) { this.generatedAt = v; }
    public void setOrgsCount(int v) { this.orgsCount = v; }
    public void setUsersCount(int v) { this.usersCount = v; }
    public void setSessions24h(int v) { this.sessions24h = v; }
    public void setMfaCoverage(MfaCoverage v) {
        this.mfaCoverage = v == null ? new MfaCoverage() : v;
    }
}
