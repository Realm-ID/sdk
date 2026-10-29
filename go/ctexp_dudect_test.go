//go:build dudect

package realmid

// dudect-style timing test of the constant-time ladder (R27); ported from the issuer's
// internal/splitsig/dudect_test.go.
//
// Gate: build tag `dudect`, so the normal `go test ./...` never compiles it. Run with
//
//	go test -tags dudect -run Dudect -count=1 -timeout 15m ./...
//
// Knobs: DUDECT_N (measurements per class, default 1500), DUDECT_T (|t| limit, default 10).
//
// Method (Reparaz et al., dudect): class A = fixed exponent, class B = fresh random exponent of the
// same width, interleaved in random order; time each call; crop the slowest tail at several
// percentiles; Welch's t between the classes; the largest |t| must stay under the limit. The fixed
// class is a LOW-weight exponent (a leaky square-and-multiply is fastest there). A positive control
// (the leaky algorithm) must trip the harness, or the verdict on ctExp would be vacuous.

import (
	"crypto/rand"
	"math"
	"math/big"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"
)

func dudectEnvInt(name string, def int) int {
	if s := os.Getenv(name); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func welchT(a, b []float64) float64 {
	mean := func(x []float64) float64 {
		s := 0.0
		for _, v := range x {
			s += v
		}
		return s / float64(len(x))
	}
	vr := func(x []float64, m float64) float64 {
		s := 0.0
		for _, v := range x {
			s += (v - m) * (v - m)
		}
		return s / float64(len(x)-1)
	}
	ma, mb := mean(a), mean(b)
	den := math.Sqrt(vr(a, ma)/float64(len(a)) + vr(b, mb)/float64(len(b)))
	if den == 0 {
		return 0
	}
	return (ma - mb) / den
}

// maxT returns the largest |t| over the uncropped data and four crop levels.
func maxT(fixed, random []float64) float64 {
	all := append(append([]float64{}, fixed...), random...)
	sort.Float64s(all)
	best := math.Abs(welchT(fixed, random))
	for _, p := range []float64{0.5, 0.75, 0.9, 0.97} {
		cut := all[int(p*float64(len(all)-1))]
		var f, r []float64
		for _, v := range fixed {
			if v <= cut {
				f = append(f, v)
			}
		}
		for _, v := range random {
			if v <= cut {
				r = append(r, v)
			}
		}
		if len(f) > 10 && len(r) > 10 {
			if t := math.Abs(welchT(f, r)); t > best {
				best = t
			}
		}
	}
	return best
}

type expFn func(base, exp, mod *big.Int) (*big.Int, error)

func measure(t *testing.T, fn expFn, n int) float64 {
	t.Helper()
	_, entry, _ := loadVectors(t)
	mod, err := b64Int(entry.N)
	if err != nil {
		t.Fatal(err)
	}
	base := new(big.Int).Rsh(mod, 3) // any public in-range base
	fixedExp := big.NewInt(3)        // low Hamming weight, short: the leaky case's fast path
	var fixed, random []float64
	for len(fixed) < n || len(random) < n {
		var b [1]byte
		_, _ = rand.Read(b[:])
		useFixed := b[0]&1 == 0
		if useFixed && len(fixed) >= n {
			useFixed = false
		} else if !useFixed && len(random) >= n {
			useFixed = true
		}
		exp := fixedExp
		if !useFixed {
			r, err := rand.Int(rand.Reader, new(big.Int).Sub(mod, big.NewInt(1)))
			if err != nil {
				t.Fatal(err)
			}
			exp = r.Add(r, big.NewInt(1))
		}
		start := time.Now()
		out, err := fn(base, exp, mod)
		d := float64(time.Since(start).Nanoseconds())
		if err != nil || out == nil {
			t.Fatalf("exponentiation failed: %v", err)
		}
		if useFixed {
			fixed = append(fixed, d)
		} else {
			random = append(random, d)
		}
	}
	return maxT(fixed, random)
}

// leakyExp is the POSITIVE CONTROL: square-and-multiply that skips the multiply on a zero bit.
func leakyExp(base, exp, mod *big.Int) (*big.Int, error) {
	r := big.NewInt(1)
	for i := exp.BitLen() - 1; i >= 0; i-- {
		r.Mul(r, r).Mod(r, mod)
		if exp.Bit(i) == 1 {
			r.Mul(r, base).Mod(r, mod)
		}
	}
	return r, nil
}

func TestCtExp_DudectHarnessDetectsLeak(t *testing.T) {
	n := dudectEnvInt("DUDECT_N", 1500)
	got := measure(t, leakyExp, n)
	t.Logf("positive control (leaky square-and-multiply): max|t|=%.1f", got)
	if got < 10 {
		t.Fatalf("harness is blind: leaky square-and-multiply gave max|t|=%.1f (< 10); the constant-time verdict would be vacuous", got)
	}
}

func TestCtExp_DudectConstantTime(t *testing.T) {
	_, entry, _ := loadVectors(t)
	n, err := b64Int(entry.N)
	if err != nil {
		t.Fatal(err)
	}
	e, err := b64Int(entry.DPartner)
	if err != nil {
		t.Fatal(err)
	}
	base := new(big.Int).Rsh(n, 3)
	// Correctness first: an instant stub is "constant time". Refuse to time a wrong answer.
	got, err := ctExp(base, e, n)
	if err != nil {
		t.Fatalf("ctExp: %v (nothing to time)", err)
	}
	if want := new(big.Int).Exp(base, e, n); got.Cmp(want) != 0 {
		t.Fatal("ctExp returns a wrong value; refusing to time it")
	}
	limit := float64(dudectEnvInt("DUDECT_T", 10))
	tv := measure(t, ctExp, dudectEnvInt("DUDECT_N", 1500))
	t.Logf("ctExp fixed-vs-random: max|t|=%.2f (limit %.0f)", tv, limit)
	if tv >= limit {
		t.Fatalf("ctExp timing depends on the exponent: max|t|=%.1f >= %.0f (fixed vs random secret)", tv, limit)
	}
}
