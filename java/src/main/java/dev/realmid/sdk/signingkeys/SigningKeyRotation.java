package dev.realmid.sdk.signingkeys;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** A realm's signing-key rotation policy. */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class SigningKeyRotation {

    private String mode;
    private String interval;
    @JsonProperty("next_rotation_at") @JsonAlias("nextRotationAt")
    private long nextRotationAt;

    public SigningKeyRotation() {}

    /** {@code "auto"} or {@code "manual"}. */
    public String mode() { return mode; }
    /** Cadence ({@code "1w"}/{@code "1mo"}/{@code "1y"}) when auto; null otherwise. */
    public String interval() { return interval; }
    /** Unix-seconds timestamp the worker next mints a replacement; 0 in manual mode. */
    public long nextRotationAt() { return nextRotationAt; }

    public void setMode(String v) { this.mode = v; }
    public void setInterval(String v) { this.interval = v; }
    public void setNextRotationAt(long v) { this.nextRotationAt = v; }
}
