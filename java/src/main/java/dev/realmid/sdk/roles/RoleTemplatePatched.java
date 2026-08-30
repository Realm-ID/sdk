package dev.realmid.sdk.roles;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Response of {@link RoleTemplatesClient#update}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class RoleTemplatePatched {

    @JsonProperty("role_template") @JsonAlias("roleTemplate")
    private RoleTemplate roleTemplate;
    /**
     * Realms whose stamped role no longer matches this template. An edit does
     * NOT propagate, so this is the drift the edit just created.
     *
     * <p><b>-1 means the count COULD NOT BE TAKEN.</b> It never means "none" —
     * treat it as unknown, not as a clean bill of health.
     */
    @JsonProperty("drifted_realms") @JsonAlias("driftedRealms")
    private int driftedRealms;

    public RoleTemplate roleTemplate() { return roleTemplate; }
    public int driftedRealms() { return driftedRealms; }
    /** True when the server could not count the drift — distinct from "no drift". */
    public boolean driftUnknown() { return driftedRealms < 0; }

    public void setRoleTemplate(RoleTemplate v) { this.roleTemplate = v; }
    public void setDriftedRealms(int v) { this.driftedRealms = v; }
}
