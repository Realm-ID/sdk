package dev.realmid.sdk.me;

import com.fasterxml.jackson.annotation.JsonAlias;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Outcome of {@link MeClient#chooseTenant} (ADR-092 D5).
 *
 * @param tenantId the membership that was kept
 * @param status always {@code "chosen"}
 * @param released how many memberships were given up. They are SUSPENDED, not
 *                 deleted (a login-time picker should not be the most
 *                 destructive operation in the product), so an admin can
 *                 restore one and the user can still leave deliberately.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record TenantChoiceResult(
        @JsonProperty("tenant_id") @JsonAlias("tenantId") String tenantId,
        String status,
        int released) {}
