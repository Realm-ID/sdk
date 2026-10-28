package dev.realmid.sdk.split;

import dev.realmid.sdk.tenants.Tenant;
import dev.realmid.sdk.tenants.TenantCreate;
import dev.realmid.sdk.tenants.TenantOwner;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static dev.realmid.sdk.split.SplitKit.*;
import static org.junit.jupiter.api.Assertions.*;

/** SPEC14_11 (R67.1, R83): create-org is a no-actor call that takes the owner and returns it seated as `owner`. */
class CreateOrgTest {

    @Test
    void ownerInlineNoActorAndReturnedSeatedAsOwner() throws Exception {
        try (Issuer f = new Issuer()) {
            String path = "/platforms/" + REALM + "/tenants";
            f.on(path, r -> json(201, Map.of("id", "t9", "display_name", "Acme", "owner_user_id", "u9",
                    "owner", Map.of("id", "u9", "email", "o@acme.test", "role", "owner"))));
            Tenant got = f.realm(null).tenants().create(TenantCreate.of("Acme", TenantOwner.ofEmail("o@acme.test")));
            var rs = f.reqs(path);
            assertEquals(1, rs.size());
            assertEquals("Bearer ptok", rs.get(0).auth(), "platform bearer");
            assertNull(rs.get(0).userToken(), "no X-User-Token");
            @SuppressWarnings("unchecked")
            Map<String, Object> owner = (Map<String, Object>) rs.get(0).body().get("owner");
            assertEquals("o@acme.test", owner.get("email"), "owner not sent inline: " + rs.get(0).body());
            assertFalse(owner.containsKey("role"), "owner carries a role field; the issuer seats `owner` itself (R83)");
            assertNotNull(got.owner(), "returned tenant does not expose the seated owner");
            assertEquals("u9", got.owner().id());
            assertEquals("owner", got.owner().role());
            assertEquals("u9", got.ownerUserId());
        }
    }
}
