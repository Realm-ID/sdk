package dev.realmid.sdk.logger;

import dev.realmid.sdk.Logging;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LoggerRedactionTest {

    @Test
    void redactsSecret() {
        String r = Logging.redact("rk_live_supersecretvalue");
        assertEquals("rk_liv...", r);
        assertTrue(!r.contains("supersecret"));
    }

    @Test
    void redactsShortString() {
        assertEquals("ab...", Logging.redact("ab"));
    }

    @Test
    void noopOnNull() {
        assertEquals("<none>", Logging.redact(null));
    }
}
