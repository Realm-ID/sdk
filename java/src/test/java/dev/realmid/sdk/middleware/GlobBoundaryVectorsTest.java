package dev.realmid.sdk.middleware;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Runs every case of sdk/testdata/glob-boundary-vectors/vectors.json (SPEC §10.2 boundary table). */
class GlobBoundaryVectorsTest {

    @Test
    void sharedVectors() throws Exception {
        JsonNode v = new ObjectMapper().readTree(Files.readAllBytes(
                Path.of("..", "testdata", "glob-boundary-vectors", "vectors.json")));
        int ran = 0;
        List<String> bad = new ArrayList<>();
        for (JsonNode c : v.get("matcher")) {
            ran++;
            boolean got = GlobMatcher.canonicalMatch(c.get("pattern").asText(), c.get("kind").asText(), c.get("path").asText());
            if (got != c.get("match").asBoolean()) bad.add(c.get("id").asText());
        }
        System.out.println("glob-boundary-vectors java: ran " + ran + ", " + bad.size() + " failed " + bad);
        assertTrue(ran > 0, "zero cases");
        assertEquals(v.get("matcher_case_count").asInt(), ran);
        assertTrue(bad.isEmpty(), "failed: " + bad);
    }
}
