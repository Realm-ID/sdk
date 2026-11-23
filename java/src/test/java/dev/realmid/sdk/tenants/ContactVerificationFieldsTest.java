package dev.realmid.sdk.tenants;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class ContactVerificationFieldsTest {
    private static final String BASE = "\"id\":\"cv\",\"contact_id\":\"c\",\"user_id\":\"u\",\"method\":\"google\","
            + "\"provider_uid\":\"p\",\"state\":\"pending\",\"created_at\":1";

    @Test
    void decodesMaskedContactFieldsAndAssertedIdentity() throws Exception {
        ContactVerification cv = new ObjectMapper().readValue("{" + BASE + ","
                + "\"contact_kind\":\"email\",\"contact_value_masked\":\"j***@example.com\","
                + "\"user_display_name\":\"Jo\",\"user_email_masked\":\"j***@example.com\","
                + "\"asserted_identity\":{\"email_masked\":\"k***@example.com\",\"phone_masked\":\"+44*******123\",\"display_name\":\"Kay\"}}",
                ContactVerification.class);
        assertEquals("email", cv.contactKind());
        assertEquals("j***@example.com", cv.contactValueMasked());
        assertEquals("Jo", cv.userDisplayName());
        assertEquals("j***@example.com", cv.userEmailMasked());
        assertEquals("k***@example.com", cv.assertedIdentity().emailMasked());
        assertEquals("+44*******123", cv.assertedIdentity().phoneMasked());
        assertEquals("Kay", cv.assertedIdentity().displayName());
    }

    @Test
    void absentFieldsDecodeToNull() throws Exception {
        ContactVerification cv = new ObjectMapper().readValue("{" + BASE + "}", ContactVerification.class);
        assertNull(cv.contactKind());
        assertNull(cv.contactValueMasked());
        assertNull(cv.assertedIdentity());
    }
}
