package projects

import (
	"context"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Ranks order the tasks of a status column. They are fractional-indexing keys (David
// Greenspan's algorithm, also what Excalidraw orders elements with): an integer part
// whose first letter gives its length, then base-62 fraction digits never ending in
// "0". Keys compare byte by byte, a key between any two others always exists, so moving
// a task rewrites only that task, and appending keeps keys short ("a0", "a1", … "az",
// "b00"). apps/web/src/features/projects/rank.ts is the same algorithm in TypeScript.

const rankDigits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// smallestInteger cannot be decremented; no key may be it.
var smallestInteger = "A" + strings.Repeat("0", 26)

var errRankSpace = errors.New("projects: no rank left on that side")

// integerLength is the length of the integer part a key starting with head has.
func integerLength(head byte) int {
	switch {
	case head >= 'a' && head <= 'z':
		return int(head-'a') + 2
	case head >= 'A' && head <= 'Z':
		return int('Z'-head) + 2
	}
	return 0
}

// splitRank returns a key's integer and fraction parts, or ok false when it is not a
// valid key.
func splitRank(key string) (integer, fraction string, ok bool) {
	if key == "" {
		return "", "", false
	}
	n := integerLength(key[0])
	if n == 0 || n > len(key) || key == smallestInteger {
		return "", "", false
	}
	integer, fraction = key[:n], key[n:]
	if strings.HasSuffix(fraction, "0") {
		return "", "", false
	}
	for i := 1; i < len(key); i++ {
		if strings.IndexByte(rankDigits, key[i]) < 0 {
			return "", "", false
		}
	}
	return integer, fraction, true
}

// validRank accepts what clients may send: a valid key of at most 128 characters.
func validRank(s string) bool {
	_, _, ok := splitRank(s)
	return ok && len(s) <= 128
}

// rankBetween returns a key strictly between a and b; "" leaves that side open. Both
// must be valid keys with a < b.
func rankBetween(a, b string) (string, error) {
	switch {
	case a == "" && b == "":
		return "a0", nil
	case a == "":
		ib, fb, _ := splitRank(b)
		if ib == smallestInteger {
			return ib + midpoint("", fb), nil
		}
		if ib < b {
			return ib, nil
		}
		if i, ok := decrementInteger(ib); ok {
			return i, nil
		}
		return "", errRankSpace
	case b == "":
		ia, fa, _ := splitRank(a)
		if i, ok := incrementInteger(ia); ok {
			return i, nil
		}
		return ia + midpoint(fa, ""), nil
	}
	ia, fa, _ := splitRank(a)
	ib, fb, _ := splitRank(b)
	if ia == ib {
		return ia + midpoint(fa, fb), nil
	}
	i, ok := incrementInteger(ia)
	if !ok {
		return "", errRankSpace
	}
	if i < b {
		return i, nil
	}
	return ia + midpoint(fa, ""), nil
}

// rankAfter returns a key after a ("" for an empty column).
func rankAfter(a string) string {
	r, err := rankBetween(a, "")
	if err != nil {
		panic(err) // unreachable: appending always has room
	}
	return r
}

// midpoint returns fraction digits strictly between a and b ("" for b is 1).
func midpoint(a, b string) string {
	if b != "" {
		// Drop the common prefix, reading a missing digit of a as zero.
		n := 0
		for n < len(b) && digitAt(a, n) == b[n] {
			n++
		}
		if n > 0 {
			return b[:n] + midpoint(tail(a, n), b[n:])
		}
	}
	lo := 0
	if a != "" {
		lo = strings.IndexByte(rankDigits, a[0])
	}
	hi := len(rankDigits)
	if b != "" {
		hi = strings.IndexByte(rankDigits, b[0])
	}
	if hi-lo > 1 {
		return string(rankDigits[(lo+hi+1)/2])
	}
	// The first digits are consecutive.
	if len(b) > 1 {
		return b[:1]
	}
	return string(rankDigits[lo]) + midpoint(tail(a, 1), "")
}

func incrementInteger(x string) (string, bool) {
	head, digits := x[0], []byte(x[1:])
	carry := true
	for i := len(digits) - 1; carry && i >= 0; i-- {
		d := strings.IndexByte(rankDigits, digits[i]) + 1
		if d == len(rankDigits) {
			digits[i] = rankDigits[0]
		} else {
			digits[i] = rankDigits[d]
			carry = false
		}
	}
	if !carry {
		return string(head) + string(digits), true
	}
	switch head {
	case 'Z':
		return "a" + rankDigits[:1], true
	case 'z':
		return "", false
	}
	h := head + 1
	if h > 'a' {
		digits = append(digits, rankDigits[0])
	} else {
		digits = digits[:len(digits)-1]
	}
	return string(h) + string(digits), true
}

func decrementInteger(x string) (string, bool) {
	head, digits := x[0], []byte(x[1:])
	borrow := true
	last := rankDigits[len(rankDigits)-1]
	for i := len(digits) - 1; borrow && i >= 0; i-- {
		d := strings.IndexByte(rankDigits, digits[i]) - 1
		if d == -1 {
			digits[i] = last
		} else {
			digits[i] = rankDigits[d]
			borrow = false
		}
	}
	if !borrow {
		return string(head) + string(digits), true
	}
	switch head {
	case 'a':
		return "Z" + string(last), true
	case 'A':
		return "", false
	}
	h := head - 1
	if h < 'Z' {
		digits = append(digits, last)
	} else {
		digits = digits[:len(digits)-1]
	}
	return string(h) + string(digits), true
}

func digitAt(s string, i int) byte {
	if i < len(s) {
		return s[i]
	}
	return '0'
}

func tail(s string, n int) string {
	if n >= len(s) {
		return ""
	}
	return s[n:]
}

// lastRank returns the rank of the last task in a status column, or "".
func lastRank(ctx context.Context, tx pgx.Tx, statusID uuid.UUID) (string, error) {
	var last string
	err := tx.QueryRow(ctx, `SELECT coalesce(max(rank), '') FROM tasks WHERE status_id = $1`, statusID).Scan(&last)
	return last, err
}
