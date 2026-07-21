package dev.realmid.sdk.stats;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * MFA-enrollment fraction of a platform's eligible user population, reported
 * as its raw parts so a caller can render "8 of 40" rather than only a rounded
 * percentage.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class MfaCoverage {

    @JsonProperty("covered_users") @JsonAlias("coveredUsers")
    private int coveredUsers;
    @JsonProperty("eligible_users") @JsonAlias("eligibleUsers")
    private int eligibleUsers;
    /** Boxed on purpose: null is a distinct state from 0. */
    private Double percent;

    public MfaCoverage() {}

    /** Users with at least one MFA authenticator enrolled. */
    public int coveredUsers() { return coveredUsers; }
    /** Users the coverage fraction is computed over. */
    public int eligibleUsers() { return eligibleUsers; }
    /**
     * Coverage percentage, or {@code null} when {@link #eligibleUsers()} is 0 —
     * there is no coverage of an empty population, and 0% would read as
     * "nobody has MFA". Null-check before unboxing.
     */
    public Double percent() { return percent; }

    public void setCoveredUsers(int v) { this.coveredUsers = v; }
    public void setEligibleUsers(int v) { this.eligibleUsers = v; }
    public void setPercent(Double v) { this.percent = v; }
}
