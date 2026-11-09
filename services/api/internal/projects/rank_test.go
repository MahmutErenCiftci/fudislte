package projects

import (
	"math/rand/v2"
	"slices"
	"strings"
	"testing"
)

// The cases of the reference implementation (fractional-indexing).
func TestRankBetween(t *testing.T) {
	for _, c := range []struct{ a, b, want string }{
		{"", "", "a0"},
		{"", "a0", "Zz"},
		{"", "Zz", "Zy"},
		{"a0", "", "a1"},
		{"a1", "", "a2"},
		{"a0", "a1", "a0V"},
		{"a1", "a2", "a1V"},
		{"a0V", "a1", "a0l"},
		{"Zz", "a0", "ZzV"},
		{"Zz", "a1", "a0"},
		{"", "Y00", "Xzzz"},
		{"bzz", "", "c000"},
		{"a0", "a0V", "a0G"},
		{"a0", "a0G", "a08"},
		{"b125", "b129", "b127"},
		{"a0", "a1V", "a1"},
		{"Zz", "a01", "a0"},
		{"", "a0V", "a0"},
		{"", "b999", "b99"},
	} {
		got, err := rankBetween(c.a, c.b)
		if err != nil || got != c.want {
			t.Errorf("rankBetween(%q, %q) = %q, %v; want %q", c.a, c.b, got, err, c.want)
		}
		if !validRank(got) || got <= c.a || (c.b != "" && got >= c.b) {
			t.Errorf("rankBetween(%q, %q) = %q is not strictly between", c.a, c.b, got)
		}
	}
}

// Random inserts anywhere in a column keep the ranks unique, valid and in order.
func TestRanksStayOrdered(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	column := []string{}
	for range 2000 {
		i := rng.IntN(len(column) + 1)
		lo, hi := "", ""
		if i > 0 {
			lo = column[i-1]
		}
		if i < len(column) {
			hi = column[i]
		}
		r, err := rankBetween(lo, hi)
		if err != nil || !validRank(r) {
			t.Fatalf("rank %q, %v between %q and %q", r, err, lo, hi)
		}
		column = slices.Insert(column, i, r)
	}
	if !slices.IsSorted(column) {
		t.Fatal("ranks are not in order")
	}
	for i := 1; i < len(column); i++ {
		if column[i] == column[i-1] {
			t.Fatalf("duplicate rank %q", column[i])
		}
	}
}

// Appending — every new task — keeps ranks short.
func TestRankAppendsStayShort(t *testing.T) {
	last := ""
	for range 100_000 {
		next := rankAfter(last)
		if next <= last {
			t.Fatalf("rankAfter(%q) = %q", last, next)
		}
		last = next
	}
	if len(last) > 4 {
		t.Fatalf("100000 appends produced %q", last)
	}
}

func TestValidRank(t *testing.T) {
	for _, r := range []string{"", "a", "a00", "a-b", "0a", "A" + strings.Repeat("0", 26), "a" + strings.Repeat("1", 128), "aş"} {
		if validRank(r) {
			t.Errorf("validRank(%q) = true", r)
		}
	}
	for _, r := range []string{"a0", "a0V", "Zz", "b127", "Xzzz"} {
		if !validRank(r) {
			t.Errorf("validRank(%q) = false", r)
		}
	}
}
