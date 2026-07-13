package dev.realmid.sdk.signingkeys;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.ArrayList;
import java.util.List;

/** GET /platforms/{id}/signing-keys body: the keyring plus rotation policy. */
@JsonIgnoreProperties(ignoreUnknown = true)
public final class SigningKeysResponse {

    private List<SigningKey> keys = new ArrayList<>();
    private SigningKeyRotation rotation = new SigningKeyRotation();

    public SigningKeysResponse() {}

    /** Keyring, newest-first (the current key is first). */
    public List<SigningKey> keys() { return keys; }
    /** The realm's rotation policy. */
    public SigningKeyRotation rotation() { return rotation; }

    public void setKeys(List<SigningKey> v) { this.keys = v; }
    public void setRotation(SigningKeyRotation v) { this.rotation = v; }
}
