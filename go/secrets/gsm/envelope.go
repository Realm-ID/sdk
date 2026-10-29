package gsm

// Share envelope v1 (SPEC §14.5, R93): the same at-rest format as the core file store, restated
// here because the core keeps its helpers unexported and this module must not widen the core.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

type envelope struct {
	V     int    `json:"v"`
	Alg   string `json:"alg"`
	KEKID string `json:"kek_id"`
	Nonce string `json:"nonce"`
	CT    string `json:"ct"`
	Ver   string `json:"ver,omitempty"`
}

// KEKID is the first 16 hex of sha256("realmid-kek-id/v1" || kek).
func KEKID(kek []byte) string {
	sum := sha256.Sum256(append([]byte("realmid-kek-id/v1"), kek...))
	return hex.EncodeToString(sum[:])[:16]
}

func newGCM(kek []byte) (cipher.AEAD, error) {
	blk, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(blk)
}

func aad(realm, kid string) []byte { return []byte("realmid-share/v1|" + realm + "|" + kid) }

func seal(kek []byte, realm string, plain []byte) ([]byte, error) {
	gcm, err := newGCM(kek)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	kid := KEKID(kek)
	return json.Marshal(envelope{V: 1, Alg: "A256GCM", KEKID: kid,
		Nonce: base64.RawURLEncoding.EncodeToString(nonce),
		CT:    base64.RawURLEncoding.EncodeToString(gcm.Seal(nil, nonce, plain, aad(realm, kid)))})
}

// open decrypts an envelope v1. A KEK id mismatch fails without trying to decrypt. Error text never
// carries input bytes.
func open(kek []byte, realm string, raw []byte) ([]byte, error) {
	var env envelope
	if json.Unmarshal(raw, &env) != nil || env.V != 1 || env.Alg != "A256GCM" {
		return nil, errors.New("gsm: secret is not an encrypted share bundle")
	}
	kid := KEKID(kek)
	if env.KEKID != kid {
		return nil, fmt.Errorf("gsm: secret is sealed under KEK %q, not the configured %q", env.KEKID, kid)
	}
	gcm, err := newGCM(kek)
	if err != nil {
		return nil, err
	}
	nonce, err1 := base64.RawURLEncoding.DecodeString(env.Nonce)
	ct, err2 := base64.RawURLEncoding.DecodeString(env.CT)
	if err1 != nil || err2 != nil || len(nonce) != gcm.NonceSize() {
		return nil, errors.New("gsm: share envelope is malformed")
	}
	plain, err := gcm.Open(nil, nonce, ct, aad(realm, kid))
	if err != nil {
		return nil, errors.New("gsm: share secret did not decrypt (wrong KEK or realm?)")
	}
	return plain, nil
}
