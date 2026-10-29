package realmid

// Split-signing co-signing (SPEC §14.2, §14.3, §14.6; plan v3 § 3.7). RealmID holds d_ri and the
// partner holds d_partner of one RSA private exponent, d = d_ri + d_partner (mod lambda). RealmID
// answers with s_ri = m^d_ri mod n over the EMSA-PKCS1-v1_5/SHA-256 encoding m of the exact
// `header.payload` bytes; the partner multiplies by m^d_partner and gets an ordinary RS256
// signature that any stock verifier accepts. The SDK checks s^e == m before it releases anything
// (verify-before-release), so a corrupt partial or a wrong share yields an error and no token.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
)

// PartialSigning is the `signing` object of a /auth/token/partial answer.
type PartialSigning struct {
	KID       string
	Header    string
	Payload   string
	PartialRI string
}

// sha256DigestInfo is the DER DigestInfo prefix for SHA-256 (RFC 8017 § 9.2 note 1).
var sha256DigestInfo = []byte{0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65,
	0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20}

// splitPub is a decoded public key plus the partner's exponent half.
type splitPub struct {
	n, e, dP *big.Int
	k        int // modulus length in bytes
}

func b64Int(s string) (*big.Int, error) {
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil || len(b) == 0 {
		return nil, errors.New("not base64url")
	}
	return new(big.Int).SetBytes(b), nil
}

func (e ShareEntry) decode() (*splitPub, error) {
	n, err := b64Int(e.N)
	if err != nil {
		return nil, fmt.Errorf("realmid: share modulus: %w", err)
	}
	ex, err := b64Int(e.E)
	if err != nil {
		return nil, fmt.Errorf("realmid: share exponent: %w", err)
	}
	if n.BitLen() < 2048 || n.Bit(0) == 0 || !ex.IsInt64() || ex.Int64() < 3 {
		return nil, errors.New("realmid: share public key is not a usable RSA key")
	}
	// d_partner is read only when a signature needs it (see needShare).
	return &splitPub{n: n, e: ex, k: (n.BitLen() + 7) / 8}, nil
}

func (e ShareEntry) decodeWithShare() (*splitPub, error) {
	p, err := e.decode()
	if err != nil {
		return nil, err
	}
	if p.dP, err = b64Int(e.DPartner); err != nil {
		return nil, errors.New("realmid: share d_partner is not base64url")
	}
	return p, nil
}

// emsaInt returns the integer of EMSA-PKCS1-v1_5 encoding of a SHA-256 digest for a k-byte modulus.
func emsaInt(digest []byte, k int) (*big.Int, error) {
	t := append(append([]byte{}, sha256DigestInfo...), digest...)
	if k < len(t)+11 || len(digest) != sha256.Size {
		return nil, errors.New("realmid: modulus too short for the signature encoding")
	}
	em := make([]byte, k)
	em[1] = 0x01
	for i := 2; i < k-len(t)-1; i++ {
		em[i] = 0xff
	}
	copy(em[k-len(t):], t)
	return new(big.Int).SetBytes(em), nil
}

// completeDigest multiplies RI's partial by the partner partial over digest and checks s^e == m.
func completeDigest(entry ShareEntry, digest, partialRI []byte) ([]byte, error) {
	p, err := entry.decodeWithShare()
	if err != nil {
		return nil, err
	}
	m, err := emsaInt(digest, p.k)
	if err != nil {
		return nil, err
	}
	sRI := new(big.Int).SetBytes(partialRI)
	if len(partialRI) == 0 || sRI.Sign() == 0 || sRI.Cmp(p.n) >= 0 {
		return nil, errors.New("realmid: RealmID's partial signature is out of range")
	}
	// d_partner is secret: constant-time exponentiation only (R27, ctexp.go). It is deliberately
	// NOT base-blinded: the usual blind x = m*r^e is valid only for the FULL private exponent.
	sP, err := ctExp(m, p.dP, p.n)
	if err != nil {
		return nil, fmt.Errorf("realmid: partner half-signature: %w", err)
	}
	s := new(big.Int).Mul(sRI, sP)
	s.Mod(s, p.n)
	if new(big.Int).Exp(s, p.e, p.n).Cmp(m) != 0 {
		return nil, errors.New("realmid: the finished signature does not verify under the pinned key; refusing to release it")
	}
	return s.FillBytes(make([]byte, p.k)), nil
}

// CompletePartial multiplies RI's partial with the partner partial computed from entry over the
// EMSA-PKCS1-v1_5/SHA-256 encoding of signingInput, checks s^e == m, and returns s. A partial
// that is corrupt, for another message, or made for another key returns an error and no bytes.
func CompletePartial(entry ShareEntry, signingInput string, partialRI []byte) ([]byte, error) {
	sum := sha256.Sum256([]byte(signingInput))
	return completeDigest(entry, sum[:], partialRI)
}

// CompleteHandshake completes the R36 handshake signature: the message is
// sha256("realmid-split-handshake/v1|"+realm+"|"+kid+"|"+nonce), used directly as the digest
// (so the result verifies with a stock RSA verifier over that digest). RealmID never half-signs a
// caller-chosen message: the SDK recomputes the message from the nonce itself [format inferred].
func CompleteHandshake(entry ShareEntry, realm, kid, nonce string, partialRI []byte) ([]byte, error) {
	msg := sha256.Sum256([]byte("realmid-split-handshake/v1|" + realm + "|" + kid + "|" + nonce))
	return completeDigest(entry, msg[:], partialRI)
}

// CoSign refuses a header that is not an RS256 access token for kid p.KID or a payload whose iss
// is not expectIssuer, completes the JWT, verifies it under entry's public key and only then
// returns it (verify-before-release).
func CoSign(entry ShareEntry, expectIssuer string, p PartialSigning) (string, error) {
	hb, err := base64.RawURLEncoding.DecodeString(p.Header)
	if err != nil {
		return "", errors.New("realmid: partial signing header is not base64url")
	}
	var hdr struct {
		Alg string  `json:"alg"`
		Typ *string `json:"typ"`
		KID string  `json:"kid"`
	}
	if err := json.Unmarshal(hb, &hdr); err != nil {
		return "", errors.New("realmid: partial signing header is not JSON")
	}
	if hdr.Alg != "RS256" || !accessTokenTyp(hdr.Typ) {
		return "", errors.New("realmid: refusing to co-sign a token with a foreign alg or typ")
	}
	if p.KID != "" && hdr.KID != "" && hdr.KID != p.KID {
		return "", errors.New("realmid: partial signing kid does not match the header")
	}
	pb, err := base64.RawURLEncoding.DecodeString(p.Payload)
	if err != nil {
		return "", errors.New("realmid: partial signing payload is not base64url")
	}
	var pl struct {
		Iss string `json:"iss"`
	}
	if err := json.Unmarshal(pb, &pl); err != nil || pl.Iss == "" || pl.Iss != expectIssuer {
		return "", errors.New("realmid: refusing to co-sign a token for a foreign issuer")
	}
	ri, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(p.PartialRI, "="))
	if err != nil {
		return "", errors.New("realmid: partial_ri is not base64url")
	}
	sig, err := CompletePartial(entry, p.Header+"."+p.Payload, ri)
	if err != nil {
		return "", err
	}
	return p.Header + "." + p.Payload + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}
