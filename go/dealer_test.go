package realmid

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"testing"
)

type dealerVec struct {
	Key struct {
		N, D, P, Q string
	} `json:"key"`
	Dealer struct {
		DRI      string `json:"d_ri"`
		DPartner string `json:"d_partner"`
	} `json:"dealer"`
}

func hexBig(t *testing.T, s string) *big.Int {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil || len(b) == 0 {
		t.Fatalf("bad hex %q: %v", s, err)
	}
	return new(big.Int).SetBytes(b)
}

// SPEC14_14_dealer check 1: the vector split under lambda(n); d_ri > d, so phi would differ.
func TestDealer_VectorSplitIsLambdaNotPhi(t *testing.T) {
	raw, err := os.ReadFile("../testdata/split-vectors/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v dealerVec
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if v.Dealer.DRI == "" {
		t.Fatal("vectors.json has no dealer case")
	}
	p, q, d := hexBig(t, v.Key.P), hexBig(t, v.Key.Q), hexBig(t, v.Key.D)
	dRI := hexBig(t, v.Dealer.DRI)
	if dRI.Cmp(d) <= 0 {
		t.Fatal("dealer case must have d_ri > d")
	}
	dP, err := splitWithDRI(p, q, d, dRI)
	if err != nil {
		t.Fatal(err)
	}
	if dP.Cmp(hexBig(t, v.Dealer.DPartner)) != 0 {
		t.Fatalf("d_partner = %x, want the vector's", dP)
	}
}

// SPEC14_14_dealer checks 2 and 3 over fresh deals.
func TestDealer_RangeAndRoundTripOver20Deals(t *testing.T) {
	one := big.NewInt(1)
	for i := 0; i < 20; i++ {
		priv, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		dRI, dP, err := splitExponent(priv)
		if err != nil {
			t.Fatal(err)
		}
		p1 := new(big.Int).Sub(priv.Primes[0], one)
		q1 := new(big.Int).Sub(priv.Primes[1], one)
		lam := new(big.Int).Div(new(big.Int).Mul(p1, q1), new(big.Int).GCD(nil, nil, p1, q1))
		for name, x := range map[string]*big.Int{"d_ri": dRI, "d_partner": dP} {
			if x.Cmp(one) < 0 || x.Cmp(lam) >= 0 {
				t.Fatalf("deal %d: %s out of [1, lambda)", i, name)
			}
		}
		m := new(big.Int).SetBytes([]byte("round trip message"))
		s := new(big.Int).Mul(new(big.Int).Exp(m, dRI, priv.N), new(big.Int).Exp(m, dP, priv.N))
		s.Mod(s, priv.N)
		if s.Cmp(new(big.Int).Exp(m, priv.D, priv.N)) != 0 {
			t.Fatalf("deal %d: combined != whole-key signature", i)
		}
	}
}

func TestDealer_ZeroHalfIsRefused(t *testing.T) {
	p, q := big.NewInt(61), big.NewInt(53)
	lam := big.NewInt(780) // lcm(60, 52)
	d := big.NewInt(413)   // 17^-1 mod 780
	if _, err := splitWithDRI(p, q, d, big.NewInt(0)); err == nil {
		t.Error("d_ri = 0 accepted")
	}
	if _, err := splitWithDRI(p, q, d, d); err == nil {
		t.Error("d_partner = 0 accepted")
	}
	if _, err := splitWithDRI(p, q, d, lam); err == nil {
		t.Error("d_ri = lambda accepted")
	}
}
