package dev.realmid.sdk.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * A saved phone-code channel as read back (PUT and GET both answer with it; SPEC 6.16). It has NO
 * secret field: {@code secretHint} is the last 4 characters of the primary secret. Provider fields
 * that do not apply to the channel are {@code null}. Timestamps are RFC3339 strings.
 *
 * @param channel         {@link #SMS} or {@link #WHATSAPP}.
 * @param provider        "twilio" or "meta".
 * @param status          {@link #STATUS_OPERATIONAL} or {@link #STATUS_FAILING}.
 * @param statusReason    the provider's reason for the last flip to failing, secret-free;
 *                        {@code null} while operational.
 * @param validatedAt     when the credentials last passed validation; {@code null} if never.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MessagingChannel(
        String channel,
        String provider,
        @JsonProperty("secret_hint") String secretHint,
        String status,
        @JsonProperty("status_reason") String statusReason,
        @JsonProperty("status_changed_at") String statusChangedAt,
        @JsonProperty("validated_at") String validatedAt,
        @JsonProperty("updated_at") String updatedAt,
        @JsonProperty("account_sid") String accountSid,
        @JsonProperty("api_key_sid") String apiKeySid,
        @JsonProperty("from_number") String fromNumber,
        @JsonProperty("messaging_service_sid") String messagingServiceSid,
        @JsonProperty("phone_number_id") String phoneNumberId,
        @JsonProperty("waba_id") String wabaId,
        @JsonProperty("template_name") String templateName,
        @JsonProperty("template_language") String templateLanguage) {

    /** Channel names, as in the route and in discovery's phone_channels. */
    public static final String SMS = "sms";
    public static final String WHATSAPP = "whatsapp";

    /** Saved, validated, and no configuration-class send failure since. Only these appear in discovery. */
    public static final String STATUS_OPERATIONAL = "operational";
    /** A configuration-class send failure hid the channel until a re-save or the issuer's 10-minute re-check passes. */
    public static final String STATUS_FAILING = "failing";
}
