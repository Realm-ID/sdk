package dev.realmid.sdk.messaging;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/** The DELETE acknowledgment ({@code status} is "deleted"). */
@JsonIgnoreProperties(ignoreUnknown = true)
public record MessagingDeleteResult(String status) {}
