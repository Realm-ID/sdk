package realmid

// Constant-time modular exponentiation for the partner's secret share d_partner (R27).
//
// math/big.Exp branches on exponent bits and big.Int arithmetic is variable-time, so the secret
// never reaches it. ctExp is a fixed-window Montgomery exponentiation over fixed-width uint64
// limbs: the sequence of operations and memory accesses depends only on the PUBLIC modulus width,
// and the window table is read by scanning every entry under a mask. Go gives no hard
// constant-time guarantee; the dudect-tagged test (ctexp_dudect_test.go) is the empirical check.
// Same algorithm as the issuer's splitsig.Ladder (ported, not imported: this module has no deps).

import (
	"errors"
	"math/big"
	"math/bits"
)

const ctWindow = 4

func ctToLimbs(x *big.Int, n int) []uint64 {
	buf := make([]byte, n*8)
	x.FillBytes(buf)
	out := make([]uint64, n)
	for i := 0; i < n; i++ {
		var v uint64
		for _, b := range buf[len(buf)-8*(i+1) : len(buf)-8*i] {
			v = v<<8 | uint64(b)
		}
		out[i] = v
	}
	return out
}

func ctFromLimbs(l []uint64) *big.Int {
	buf := make([]byte, len(l)*8)
	for i, v := range l {
		for j := 0; j < 8; j++ {
			buf[len(buf)-1-8*i-j] = byte(v >> (8 * j))
		}
	}
	return new(big.Int).SetBytes(buf)
}

// ctMontMul sets z = a*b*R^-1 mod mod (CIOS), constant-time over the limbs. t is scratch of
// len(mod)+2. z may alias a or b.
func ctMontMul(z, a, b, mod, t []uint64, n0 uint64) {
	n := len(mod)
	for i := range t {
		t[i] = 0
	}
	for i := 0; i < n; i++ {
		var c uint64
		bi := b[i]
		for j := 0; j < n; j++ {
			hi, lo := bits.Mul64(a[j], bi)
			var c1, c2 uint64
			lo, c1 = bits.Add64(lo, t[j], 0)
			hi += c1
			lo, c2 = bits.Add64(lo, c, 0)
			hi += c2
			t[j] = lo
			c = hi
		}
		var cc uint64
		t[n], cc = bits.Add64(t[n], c, 0)
		t[n+1] = cc

		m := t[0] * n0
		hi, lo := bits.Mul64(m, mod[0])
		_, c1 := bits.Add64(lo, t[0], 0)
		c = hi + c1
		for j := 1; j < n; j++ {
			hi, lo := bits.Mul64(m, mod[j])
			var d1, d2 uint64
			lo, d1 = bits.Add64(lo, t[j], 0)
			hi += d1
			lo, d2 = bits.Add64(lo, c, 0)
			hi += d2
			t[j-1] = lo
			c = hi
		}
		var s, c3 uint64
		s, c3 = bits.Add64(t[n], c, 0)
		t[n-1] = s
		t[n] = t[n+1] + c3
	}
	// Conditional subtraction of mod, selected by mask (no branch).
	var borrow uint64
	d := make([]uint64, n)
	for j := 0; j < n; j++ {
		d[j], borrow = bits.Sub64(t[j], mod[j], borrow)
	}
	useD := t[n] | (borrow ^ 1)
	mask := -(useD & 1)
	for j := 0; j < n; j++ {
		z[j] = (d[j] & mask) | (t[j] &^ mask)
	}
}

// ctExp returns base^exp mod mod with no operation or memory access depending on the bits of exp.
// mod is odd and > 1; exp >= 0. The exponent is padded to max(bitlen(mod), bitlen(exp)) bits so
// its magnitude is not leaked below the modulus width.
func ctExp(base, exp, mod *big.Int) (*big.Int, error) {
	if mod == nil || base == nil || exp == nil {
		return nil, errors.New("realmid: nil operand")
	}
	if mod.Sign() <= 0 || mod.Bytes()[len(mod.Bytes())-1]&1 == 0 || mod.Cmp(big.NewInt(1)) == 0 {
		return nil, errors.New("realmid: modulus must be odd and > 1")
	}
	if exp.Sign() < 0 {
		return nil, errors.New("realmid: negative exponent")
	}
	n := (mod.BitLen() + 63) / 64
	m := ctToLimbs(mod, n)

	// n0 = -mod^-1 mod 2^64 (Newton; mod is public).
	inv := m[0]
	for i := 0; i < 6; i++ {
		inv *= 2 - m[0]*inv
	}
	n0 := -inv

	// R mod mod and R^2 mod mod via big (public values only).
	r := new(big.Int).Lsh(big.NewInt(1), uint(64*n))
	one := ctToLimbs(new(big.Int).Mod(r, mod), n)
	rr := ctToLimbs(new(big.Int).Mod(new(big.Int).Mul(r, r), mod), n)
	b := ctToLimbs(new(big.Int).Mod(base, mod), n)

	t := make([]uint64, n+2)
	bm := make([]uint64, n)
	ctMontMul(bm, b, rr, m, t, n0)

	var table [1 << ctWindow][]uint64
	table[0] = one
	table[1] = bm
	for i := 2; i < 1<<ctWindow; i++ {
		table[i] = make([]uint64, n)
		ctMontMul(table[i], table[i-1], bm, m, t, n0)
	}

	expBits := mod.BitLen()
	if eb := exp.BitLen(); eb > expBits {
		expBits = eb
	}
	nWin := (expBits + ctWindow - 1) / ctWindow
	eb := make([]byte, (nWin*ctWindow+7)/8)
	exp.FillBytes(eb)

	acc := make([]uint64, n)
	copy(acc, one)
	sel := make([]uint64, n)
	for w := nWin - 1; w >= 0; w-- {
		for s := 0; s < ctWindow; s++ {
			ctMontMul(acc, acc, acc, m, t, n0)
		}
		bitPos := w * ctWindow
		byt := eb[len(eb)-1-bitPos/8]
		win := uint64(byt>>(uint(bitPos)%8)) & (1<<ctWindow - 1)
		for j := range sel {
			sel[j] = 0
		}
		for i := 0; i < 1<<ctWindow; i++ {
			// mask is all-ones iff i == win, computed without a branch.
			x := uint64(i) ^ win
			mask := ((x | -x) >> 63) - 1
			for j := 0; j < n; j++ {
				sel[j] |= table[i][j] & mask
			}
		}
		ctMontMul(acc, acc, sel, m, t, n0)
	}
	// Leave Montgomery form: multiply by 1.
	unit := make([]uint64, n)
	unit[0] = 1
	ctMontMul(acc, acc, unit, m, t, n0)
	return ctFromLimbs(acc), nil
}
