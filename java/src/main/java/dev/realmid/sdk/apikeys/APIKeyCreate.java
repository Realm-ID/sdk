package dev.realmid.sdk.apikeys;

import java.util.List;

public record APIKeyCreate(String displayName, List<String> scopes) {
    public static APIKeyCreate of(String displayName) { return new APIKeyCreate(displayName, null); }
    public static APIKeyCreate of(String displayName, List<String> scopes) { return new APIKeyCreate(displayName, scopes); }
}
