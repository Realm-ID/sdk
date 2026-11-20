package dev.realmid.sdk.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** A stored refusal keeps the issuer's Retry-After through the JSON the shared store holds. */
class RefreshOutcomeRetryAfterTest {

    @Test
    void storedErrorKeepsRetryAfterThroughEncodeDecode() throws Exception {
        ObjectMapper m = new ObjectMapper();
        RefreshOutcome in = RefreshOutcome.error("t1", 429, "server_error", "slow down", null).withRetryAfter(21);
        RefreshOutcome out = RefreshOutcome.decode(m, in.encode(m));
        assertEquals(21L, out.retryAfterSeconds());
        assertEquals(429, out.status());
    }
}
