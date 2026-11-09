package passwords

import (
	"strings"
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	hash, err := Hash("doğru şifre 42")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("hash = %q", hash)
	}
	other, _ := Hash("doğru şifre 42")
	if other == hash {
		t.Fatal("hashes of the same password must differ (salt)")
	}
	for _, tc := range []struct {
		password string
		want     bool
	}{{"doğru şifre 42", true}, {"Doğru şifre 42", false}, {"", false}} {
		ok, err := Verify(hash, tc.password)
		if err != nil || ok != tc.want {
			t.Fatalf("Verify(%q) = %v, %v", tc.password, ok, err)
		}
	}
}

func TestVerifyRejectsMalformedHashes(t *testing.T) {
	for _, h := range []string{
		"",
		"$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5a2V5",
		"$argon2id$v=19$m=99999999,t=2,p=1$c2FsdHNhbHQ$a2V5a2V5a2V5a2V5a2V5",
		"$argon2id$v=19$m=19456,t=2,p=1$!!$a2V5a2V5a2V5a2V5a2V5",
	} {
		if _, err := Verify(h, "x"); err != ErrMalformed {
			t.Fatalf("Verify(%q) err = %v", h, err)
		}
	}
}

func TestCheck(t *testing.T) {
	if Check("kısa") == "" || Check(strings.Repeat("a", 129)) == "" {
		t.Fatal("length limits not enforced")
	}
	if msg := Check("çok gizli"); msg != "" {
		t.Fatalf("Check = %q", msg)
	}
}
