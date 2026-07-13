package dev.realmid.sdk.signingkeys;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.ArrayList;
import java.util.List;

/** Result of a signing-key rotate: the new current kid plus any retired kids. */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class RotateSigningKeyResult {

    private String kid;
    @JsonProperty("retired_kids") @JsonAlias("retiredKids")
    private List<String> retiredKids = new ArrayList<>();

    public RotateSigningKeyResult() {}

    /** The new current key id. */
    public String kid() { return kid; }
    /** Key ids retired by this rotation (may be empty). */
    public List<String> retiredKids() { return retiredKids; }

    public void setKid(String v) { this.kid = v; }
    public void setRetiredKids(List<String> v) { this.retiredKids = v; }
}
