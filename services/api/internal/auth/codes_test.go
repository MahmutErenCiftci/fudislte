package auth

import (
	"testing"

	"github.com/google/uuid"
)

func TestNewCodeShape(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		c := newCode()
		if len(c) != codeDigits || normalizeCode(c) != c {
			t.Fatalf("bad code %q", c)
		}
		seen[c] = true
	}
	if len(seen) < 195 {
		t.Fatalf("codes repeat too often: %d unique of 200", len(seen))
	}
}

func TestNormalizeCode(t *testing.T) {
	for in, want := range map[string]string{"1234 5678": "12345678", " 1234-5678\n": "12345678", "١٢٣": ""} {
		if got := normalizeCode(in); got != want {
			t.Errorf("normalizeCode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestHashCodeIsSaltedByID(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	if string(hashCode(a, "12345678")) == string(hashCode(b, "12345678")) {
		t.Fatal("hashes of the same code must differ between IDs")
	}
}

func TestNameFromEmail(t *testing.T) {
	for in, want := range map[string]string{
		"dana.yilmaz@firma.com": "Dana Yilmaz",
		"j_smith-2@example.com": "J Smith",
		"çağrı@firma.com":       "Çağrı",
		"1234@example.com":      "1234",
	} {
		if got := NameFromEmail(in); got != want {
			t.Errorf("NameFromEmail(%q) = %q, want %q", in, got, want)
		}
	}
}
