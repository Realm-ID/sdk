package realmid

// R27: the partner-half exponentiation (secret d_partner) must be constant-time. These tests pin
// that structurally (no variable-time operation reachable on the secret) and functionally (ctExp
// agrees with math/big on public operands). The empirical check is the `dudect`-tagged test.

import (
	"crypto/rand"
	"go/ast"
	"go/parser"
	"go/token"
	"math/big"
	"testing"
)

func parseSrc(t *testing.T, file string) *ast.File {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), file, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v (the constant-time ladder must live there)", file, err)
	}
	return f
}

// R27: no big.Int.Exp, no secret-indexed table in the secret-exponent path.
func TestCosign_SecretExponentPathHasNoVariableTimeOps(t *testing.T) {
	cs := parseSrc(t, "cosign.go")
	ct := parseSrc(t, "ctexp.go")

	// 1. the old math/big ladder is gone.
	for _, d := range cs.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == "ladderExp" {
			t.Fatal("cosign.go still defines ladderExp (variable-time big.Int ladder, pair[b])")
		}
	}
	// 2. in cosign.go the only big.Int Exp is the PUBLIC verify (s^e) inside completeDigest, and the
	//    partner half goes through ctExp.
	usesCT := false
	for _, d := range cs.Decls {
		fd, ok := d.(*ast.FuncDecl)
		if !ok {
			continue
		}
		ast.Inspect(fd, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			switch fn := call.Fun.(type) {
			case *ast.SelectorExpr:
				if fn.Sel.Name == "Exp" && fd.Name.Name != "completeDigest" {
					t.Errorf("%s calls big.Int.Exp", fd.Name.Name)
				}
			case *ast.Ident:
				if fn.Name == "ctExp" && fd.Name.Name == "completeDigest" {
					usesCT = true
				}
			}
			return true
		})
	}
	if !usesCT {
		t.Error("completeDigest does not call ctExp for the partner half")
	}
	// 3. the ladder file: no math/big method that branches on exponent bits, and the window table
	//    is never indexed by a secret-derived value (the masked full scan uses the loop counter).
	ast.Inspect(ct, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.SelectorExpr:
			switch x.Sel.Name {
			case "Exp", "ModInverse", "Rsh", "Bit", "TrailingZeroBits":
				t.Errorf("ctexp.go uses big.Int.%s", x.Sel.Name)
			}
		case *ast.IndexExpr:
			if id, ok := x.Index.(*ast.Ident); ok && (id.Name == "digit" || id.Name == "b") {
				t.Errorf("ctexp.go indexes by secret-derived %q", id.Name)
			}
		}
		return true
	})
}

func TestCtExp_MatchesBigExp(t *testing.T) {
	mods := []*big.Int{big.NewInt(3), big.NewInt(1000003)}
	for _, bits := range []int{64, 65, 127, 128, 521, 2048} {
		m, err := rand.Prime(rand.Reader, bits)
		if err != nil {
			t.Fatal(err)
		}
		mods = append(mods, m)
	}
	for _, mod := range mods {
		exps := []*big.Int{big.NewInt(0), big.NewInt(1), big.NewInt(2), big.NewInt(65537),
			new(big.Int).Lsh(big.NewInt(1), 300), new(big.Int).Sub(mod, big.NewInt(1))}
		for _, e := range exps {
			b, _ := rand.Int(rand.Reader, mod)
			got, err := ctExp(b, e, mod)
			if err != nil {
				t.Fatalf("ctExp: %v", err)
			}
			if want := new(big.Int).Exp(b, e, mod); got.Cmp(want) != 0 {
				t.Fatalf("mod %d bits exp %v: got %v want %v", mod.BitLen(), e, got, want)
			}
		}
	}
	if _, err := ctExp(big.NewInt(2), big.NewInt(3), big.NewInt(10)); err == nil {
		t.Error("even modulus accepted")
	}
}

// BenchmarkCoSign2048 times the partner half (the secret-exponent exponentiation) at 2048 bits.
func BenchmarkCoSign2048(b *testing.B) {
	m, _ := rand.Prime(rand.Reader, 2048)
	d, _ := rand.Int(rand.Reader, m)
	base, _ := rand.Int(rand.Reader, m)
	for i := 0; i < b.N; i++ {
		if _, err := ctExp(base, d, m); err != nil {
			b.Fatal(err)
		}
	}
}
