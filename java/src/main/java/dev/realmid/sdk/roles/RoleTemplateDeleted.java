package dev.realmid.sdk.roles;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Response of {@link RoleTemplatesClient#delete}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class RoleTemplateDeleted {

    private String status;
    /**
     * Realms still holding a role stamped from the deleted template. The
     * vocabulary row is gone; those roles and their holders are not.
     *
     * <p><b>-1 means the count could not be taken.</b>
     */
    @JsonProperty("realms_still_holding") @JsonAlias("realmsStillHolding")
    private int realmsStillHolding;

    public String status() { return status; }
    public int realmsStillHolding() { return realmsStillHolding; }
    /** True when the server could not count the orphans — distinct from "none". */
    public boolean orphanCountUnknown() { return realmsStillHolding < 0; }

    public void setStatus(String v) { this.status = v; }
    public void setRealmsStillHolding(int v) { this.realmsStillHolding = v; }
}
