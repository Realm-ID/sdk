package dev.realmid.sdk.messaging;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * The WhatsApp save body (SPEC 6.16): the realm's own Meta WhatsApp Business Account.
 * {@code templateName} / {@code templateLanguage} name an APPROVED authentication template with a
 * copy-code button. {@code accessToken} is a System User token and is WRITE-ONLY: it never appears
 * in {@link #toString()} and no read type carries it.
 */
public record WhatsAppChannel(
        @JsonProperty("phone_number_id") String phoneNumberId,
        @JsonProperty("waba_id") String wabaId,
        @JsonProperty("access_token") String accessToken,
        @JsonProperty("template_name") String templateName,
        @JsonProperty("template_language") String templateLanguage) {

    /** Never prints a credential. */
    @Override
    public String toString() {
        return "WhatsAppChannel[phoneNumberId=" + phoneNumberId + ", wabaId=" + wabaId
                + ", templateName=" + templateName + ", templateLanguage=" + templateLanguage
                + ", accessToken=" + (accessToken == null ? "unset" : "***") + "]";
    }
}
