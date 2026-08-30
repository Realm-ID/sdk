package dev.realmid.sdk.roles;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/** Response of {@link RoleTemplatesClient#create}. */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class RoleTemplateCreated {

    @JsonProperty("role_template") @JsonAlias("roleTemplate")
    private RoleTemplate roleTemplate;
    /**
     * How many realm role rows the fan-out created.
     *
     * <p>This is the difference between "the role exists for realms created from
     * now on" and "the role reached the realms that already exist". Only the
     * second is what ADR-101 promises, so read it rather than assuming.
     */
    @JsonProperty("realms_stamped") @JsonAlias("realmsStamped")
    private int realmsStamped;

    public RoleTemplate roleTemplate() { return roleTemplate; }
    public int realmsStamped() { return realmsStamped; }

    public void setRoleTemplate(RoleTemplate v) { this.roleTemplate = v; }
    public void setRealmsStamped(int v) { this.realmsStamped = v; }
}
