// Package passwords hashes room passwords with Argon2id (ADR-0010). FUDISLTE has no
// account passwords; these only guard secure rooms, on top of authorization.
package passwords

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

// Parameters follow the OWASP recommendation for Argon2id (19 MiB, 2 passes, 1 lane).
// They are stored with each hash, so raising them later keeps old hashes valid.
const (
	memoryKiB  = 19 * 1024
	iterations = 2
	lanes      = 1
	saltLen    = 16
	keyLen     = 32

	MinLength = 8
	MaxLength = 128

	// maxMemoryKiB bounds the parameters accepted from a stored hash.
	maxMemoryKiB = 256 * 1024
)

// slots bounds how many hashes run at once, and with it the memory they take.
var slots = make(chan struct{}, 4)

var ErrMalformed = errors.New("passwords: malformed hash")

// Check returns a user-facing message when password does not meet the policy.
func Check(password string) string {
	n := utf8.RuneCountInString(password)
	switch {
	case !utf8.ValidString(password):
		return "Use a valid password."
	case n < MinLength:
		return "Use at least 8 characters."
	case n > MaxLength:
		return "Use at most 128 characters."
	}
	return ""
}

// Hash returns the PHC-formatted Argon2id hash of password.
func Hash(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := derive(password, salt, iterations, memoryKiB, lanes, keyLen)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, memoryKiB, iterations, lanes, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// Verify reports whether password matches encoded, in constant time.
func Verify(encoded, password string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false, ErrMalformed
	}
	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false, ErrMalformed
	}
	var memory, passes uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &passes, &threads); err != nil ||
		memory == 0 || memory > maxMemoryKiB || passes == 0 || passes > 10 || threads == 0 {
		return false, ErrMalformed
	}
	enc := base64.RawStdEncoding
	salt, err := enc.DecodeString(parts[4])
	if err != nil || len(salt) < 8 {
		return false, ErrMalformed
	}
	want, err := enc.DecodeString(parts[5])
	if err != nil || len(want) < 16 {
		return false, ErrMalformed
	}
	got := derive(password, salt, passes, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

func derive(password string, salt []byte, passes, memory uint32, threads uint8, length uint32) []byte {
	slots <- struct{}{}
	defer func() { <-slots }()
	return argon2.IDKey([]byte(password), salt, passes, memory, threads, length)
}
