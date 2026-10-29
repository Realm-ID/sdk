#!/usr/bin/env python3
"""Generate deterministic cross-language test vectors for 2-of-2 additive split RSA signing
(split-signing v2, C2/R43). Stdlib only. Re-running reproduces byte-identical output.

  d = d_ri + d_partner (mod lambda(N)); s_ri = m^d_ri, s_p = m^d_partner, s = s_ri*s_p mod N;
  every combiner verifies s^e mod N == m before release. RSA-2048, e = 65537 (R22).

Usage: gen-split-vectors.py [output.json]   (default: ../testdata/split-vectors/vectors.json)
Exit non-zero on any self-check mismatch.
"""
import base64, hashlib, json, os, sys
from math import gcd

SEED = b"realmid-split-vectors/v1/2026-10-27"  # the ONLY entropy; changing it changes every vector
E = 65537
BITS = 2048
K = BITS // 8
# DER DigestInfo prefix for SHA-256 (RFC 8017 sec. 9.2 note 1)
SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")


class Drbg:
    """SHA-256 counter-mode stream: deterministic and independent of Python's random module."""

    def __init__(self, label):
        self.key, self.ctr = hashlib.sha256(SEED + b"|" + label.encode()).digest(), 0

    def bytes(self, n):
        out = b""
        while len(out) < n:
            out += hashlib.sha256(self.key + self.ctr.to_bytes(8, "big")).digest()
            self.ctr += 1
        return out[:n]

    def bits(self, n):
        nb = (n + 7) // 8
        return int.from_bytes(self.bytes(nb), "big") >> (8 * nb - n)

    def below(self, hi):  # uniform in [0, hi) by rejection
        nb = hi.bit_length()
        while True:
            v = self.bits(nb)
            if v < hi:
                return v


def is_prime(n, rng, rounds=64):
    """Miller-Rabin, 64 random bases (error <= 4^-64)."""
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = 2 + rng.below(n - 3)
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = x * x % n
            if x == n - 1:
                break
        else:
            return False
    return True


def gen_prime(rng, bits):
    while True:
        c = rng.bits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1  # top two bits set: N is full 2048
        if (c - 1) % E != 0 and is_prime(c, rng):
            return c


def gen_key(label):
    rng = Drbg(label)
    while True:
        p, q = gen_prime(rng, BITS // 2), gen_prime(rng, BITS // 2)
        if p == q:
            continue
        n = p * q
        if n.bit_length() != BITS:
            continue
        lam = (p - 1) // gcd(p - 1, q - 1) * (q - 1)
        d = pow(E, -1, lam)
        d_ri = 1 + rng.below(lam - 1)  # uniform in [1, lambda)
        d_p = (d - d_ri) % lam
        if d_p == 0:
            continue
        return dict(p=p, q=q, n=n, lam=lam, d=d, d_ri=d_ri, d_p=d_p)


def emsa_from_digest(digest):
    """EMSA-PKCS1-v1_5, hand-encoded: 00 01 FF..FF 00 DigestInfo(SHA-256, digest)."""
    assert len(digest) == 32
    t = SHA256_PREFIX + digest
    return b"\x00\x01" + b"\xff" * (K - len(t) - 3) + b"\x00" + t


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64u(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def h(i, width=K):
    return i.to_bytes(width, "big").hex()


def verify_by_hand(n, token):
    """Independent RS256 verify: parse the recovered EM manually, never re-encode."""
    hdr, pl, sig = token.split(".")
    raw = unb64u(sig)
    s = int.from_bytes(raw, "big")
    if len(raw) != K or s >= n:
        return False
    em = pow(s, E, n).to_bytes(K, "big")
    if em[0:2] != b"\x00\x01":
        return False
    i = 2
    while em[i] == 0xFF:
        i += 1
    if i < 10 or em[i] != 0:
        return False
    return em[i + 1:] == SHA256_PREFIX + hashlib.sha256((hdr + "." + pl).encode("ascii")).digest()


JWT_CASES = [
    ("basic", {"alg": "RS256", "typ": "JWT", "kid": "k1"},
     {"sub": "u_001", "iss": "https://auth.realmid.dev/r1", "aud": "app", "iat": 1790000000, "exp": 1790000900}),
    ("roles-and-scope", {"alg": "RS256", "kid": "split-2026-10"},
     {"sub": "u_002", "iss": "https://auth.realmid.dev/r1", "scope": "orders:read orders:write",
      "roles": ["admin", "member"], "mfa": True, "iat": 1790003600, "exp": 1790004500}),
    ("non-ascii-claims", {"alg": "RS256", "typ": "JWT", "kid": "k-ünï"},
     {"sub": "u_003", "name": "Zoë Ångström ☃ 日本語 \U0001F512",
      "email": "zoe@exämple.org", "iat": 1790007200, "exp": 1790008100}),
    ("long-payload", {"alg": "RS256", "typ": "JWT", "kid": "k1"},
     {"sub": "u_004", "orgs": [{"id": "org_%03d" % i, "role": "member"} for i in range(40)], "exp": 1790010000}),
    ("minimal-empty-claims", {"alg": "RS256", "kid": "k1"}, {}),
]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "testdata", "split-vectors", "vectors.json")
    key, other = gen_key("key-main"), gen_key("key-wrong")
    n = key["n"]
    fails = []

    def check(c, msg):
        if not c:
            fails.append(msg)

    check(E * key["d"] % key["lam"] == 1, "e*d != 1 mod lambda")
    check((key["d_ri"] + key["d_p"]) % key["lam"] == key["d"], "d_ri + d_p != d")
    check(1 <= key["d_ri"] < key["lam"], "d_ri out of range")
    check(key["n"] == key["p"] * key["q"] and key["n"].bit_length() == BITS, "bad modulus")

    def sign(em_bytes):
        m = int.from_bytes(em_bytes, "big")
        s_ri, s_p = pow(m, key["d_ri"], n), pow(m, key["d_p"], n)
        s = s_ri * s_p % n
        check(s == pow(m, key["d"], n), "s != m^d")
        check(pow(s, E, n) == m, "s^e != m")
        return m, s_ri, s_p, s

    cases = []
    for name, hdr, pl in JWT_CASES:
        hj = json.dumps(hdr, separators=(",", ":"), ensure_ascii=False)
        pj = json.dumps(pl, separators=(",", ":"), ensure_ascii=False)
        si = b64u(hj.encode("utf-8")) + "." + b64u(pj.encode("utf-8"))
        m, s_ri, s_p, s = sign(emsa_from_digest(hashlib.sha256(si.encode("ascii")).digest()))
        tok = si + "." + b64u(s.to_bytes(K, "big"))
        check(verify_by_hand(n, tok), "hand verify failed: " + name)
        cases.append(dict(name=name, header_json=hj, payload_json=pj, signing_input=si, m=h(m), s_ri=h(s_ri),
                          s_p=h(s_p), s=h(s), jwt=tok))

    # Handshake (R36 / v2 sec. 3): message = sha256("realmid-split-handshake/v1|"+realm+"|"+kid+"|"+nonce),
    # 32 bytes, used directly as the SHA-256 digest inside DigestInfo (NOT hashed again).
    realm, kid, nonce = "realm_vec01", "k1", b64u(Drbg("nonce").bytes(32))
    pre = "realmid-split-handshake/v1|%s|%s|%s" % (realm, kid, nonce)
    msg = hashlib.sha256(pre.encode()).digest()
    m, s_ri, s_p, s = sign(emsa_from_digest(msg))
    handshake = dict(realm=realm, kid=kid, nonce=nonce, preimage=pre, message=msg.hex(), m=h(m), s_ri=h(s_ri),
                     s_p=h(s_p), s=h(s))

    # Downgrade challenge (owner ruling C5 #4, SPEC 14.6): same construction as the handshake, its own
    # purpose-bound preimage "realmid-split-downgrade/v1|"+realm+"|"+kid+"|"+nonce (issuer splitcustody).
    dnonce = b64u(Drbg("downgrade-nonce").bytes(32))
    dpre = "realmid-split-downgrade/v1|%s|%s|%s" % (realm, kid, dnonce)
    dmsg = hashlib.sha256(dpre.encode()).digest()
    check(dmsg != msg, "downgrade digest equals handshake digest")
    m, s_ri, s_p, s = sign(emsa_from_digest(dmsg))
    downgrade = dict(realm=realm, kid=kid, nonce=dnonce, preimage=dpre, message=dmsg.hex(), m=h(m), s_ri=h(s_ri),
                     s_p=h(s_p), s=h(s))

    # Negatives, on the first JWT case: the combiner must REFUSE (s^e != m).
    base = cases[0]
    m0, s_ri0, s_p0 = int(base["m"], 16), int(base["s_ri"], 16), int(base["s_p"], 16)
    bad_p = s_p0 ^ 1  # one flipped bit
    wrong_sp = pow(m0, other["d_p"], other["n"]) % n  # partner partial from an UNRELATED key, reduced mod N
    negatives = []
    for name, sp, why in (("corrupted-partner-partial", bad_p, "one bit of s_p flipped"),
                          ("wrong-key-partner-partial", wrong_sp, "s_p = m^d_partner' mod N' from an unrelated key")):
        s = s_ri0 * sp % n
        check(sp < n, "partial out of range: " + name)
        check(pow(s, E, n) != m0, "negative case verifies: " + name)
        tok = base["signing_input"] + "." + b64u(s.to_bytes(K, "big"))
        check(not verify_by_hand(n, tok), "negative JWT verifies by hand: " + name)
        negatives.append(dict(name=name, why=why, based_on=base["name"], m=base["m"], s_ri=base["s_ri"], s_p=h(sp),
                              combined_s=h(s), expect="combiner_refuses", rejected_jwt=tok))
    negatives[1]["wrong_key_n"] = h(other["n"])
    check(other["n"] != n, "wrong key equals key")

    if fails:
        print("SELF-CHECK FAILED:\n  " + "\n  ".join(fails), file=sys.stderr)
        sys.exit(1)

    doc = dict(version=1, seed=SEED.decode(), encoding="big integers: lowercase hex, zero-padded to 512 chars",
               key=dict(bits=BITS, n=h(n), e=E, lambda_n=h(key["lam"]), d=h(key["d"]), d_ri=h(key["d_ri"]),
                        d_partner=h(key["d_p"]), p=h(key["p"], K // 2), q=h(key["q"], K // 2)),
               jwt_cases=cases, handshake=handshake, downgrade=downgrade, negative_cases=negatives)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("OK: %d jwt cases, 1 handshake, 1 downgrade, %d negatives, all self-checks passed -> %s"
          % (len(cases), len(negatives), out))


if __name__ == "__main__":
    main()
