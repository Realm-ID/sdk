package dev.realmid.sdk.roles;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HashMap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The shared role-predicate vectors, sdk/SPEC.md section 6.3. Every case runs;
 * the declared counts must match what ran.
 */
class RolePredicateVectorsTest {

    private static final ObjectMapper M = new ObjectMapper();
    private static final Path FILE = Path.of("..", "testdata", "role-predicate-vectors", "vectors.json");

    private static List<String> strings(JsonNode arr) {
        List<String> out = new ArrayList<>();
        arr.forEach(n -> out.add(n.asText()));
        return out;
    }

    private static List<Permission> catalog(JsonNode arr) {
        List<Permission> out = new ArrayList<>();
        arr.forEach(n -> out.add(new Permission(n.get("key").asText(), null, n.get("action").asText(), null)));
        return out;
    }

    @Test
    void sharedVectors() throws Exception {
        JsonNode v = M.readTree(Files.readAllBytes(FILE));
        Map<String, List<Permission>> named = new HashMap<>();
        v.get("catalogs").fields().forEachRemaining(e -> named.put(e.getKey(), catalog(e.getValue())));

        int c = 0, a = 0, failed = 0;
        for (JsonNode k : v.get("confers")) {
            c++;
            List<String> perms = strings(k.get("permissions"));
            JsonNode cat = k.get("catalog");
            boolean got;
            if (cat.isNull()) {
                got = RolePredicates.confersAuthority(perms);
            } else if (cat.isArray()) {
                got = RolePredicates.confersAuthority(perms, catalog(cat));
            } else {
                got = RolePredicates.confersAuthority(perms, named.get(cat.asText()));
            }
            if (got != k.get("confers").asBoolean()) {
                failed++;
                System.err.println(k.get("id").asText() + ": confers = " + got);
            }
        }
        for (JsonNode k : v.get("assignable")) {
            a++;
            RoleObject role = M.treeToValue(k.get("role"), RoleObject.class);
            boolean got = RolePredicates.isRoleAssignableTo(role, k.get("kind").asText());
            if (got != k.get("assignable").asBoolean()) {
                failed++;
                System.err.println(k.get("id").asText() + ": assignable = " + got);
            }
        }
        System.out.println("role-predicate-vectors java: ran " + c + " confers + " + a + " assignable cases, " + failed + " failed");
        assertEquals(0, failed);
        assertTrue(c > 0 && a > 0);
        assertEquals(v.get("confers_case_count").asInt(), c);
        assertEquals(v.get("assignable_case_count").asInt(), a);
    }
}
