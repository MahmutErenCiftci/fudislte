package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/netip"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
	"fudislte/api/internal/httpx"
)

// CodePurpose separates codes so a code issued for one flow cannot complete another.
type CodePurpose string

const (
	PurposeLogin      CodePurpose = "login"
	PurposeSetup      CodePurpose = "setup"
	PurposeInvitation CodePurpose = "invitation"
)

// One-time codes: 8 digits (10^8 possibilities), valid for 10 minutes, at most 5
// guesses each. Together with per-email issuance limits this keeps online guessing
// impractical (see docs/security/threat-model.md).
const (
	CodeTTL         = 10 * time.Minute
	codeDigits      = 8
	codeMaxAttempts = 5
)

var ErrInvalidCode = httpx.NewError(http.StatusUnauthorized, "invalid_code", "The code is incorrect or has expired. Request a new code.")

func newCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(100_000_000))
	if err != nil {
		panic(err) // crypto/rand does not fail on supported platforms
	}
	return fmt.Sprintf("%0*d", codeDigits, n.Int64())
}

// hashCode salts with the code's ID so equal codes never share a hash.
func hashCode(id uuid.UUID, code string) []byte {
	sum := sha256.Sum256([]byte(id.String() + ":" + code))
	return sum[:]
}

// normalizeCode keeps digits only, so "1234 5678" and "1234-5678" are accepted.
func normalizeCode(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsDigit(r) && r < 128 {
			return r
		}
		return -1
	}, s)
}

// IssueCode creates a code for email and purpose, invalidating earlier ones, and
// returns the plaintext code for delivery.
func IssueCode(ctx context.Context, q database.Querier, email string, purpose CodePurpose, ip netip.Addr) (string, error) {
	if _, err := q.Exec(ctx, `
		UPDATE email_codes SET consumed_at = now()
		WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL`, email, string(purpose)); err != nil {
		return "", err
	}
	if _, err := q.Exec(ctx, `DELETE FROM email_codes WHERE email = $1 AND created_at < now() - interval '1 day'`, email); err != nil {
		return "", err
	}
	code := newCode()
	id := uuid.Must(uuid.NewV7())
	_, err := q.Exec(ctx, `
		INSERT INTO email_codes (id, email, purpose, code_hash, ip_address, expires_at)
		VALUES ($1, $2, $3, $4, $5::inet, $6)`,
		id, email, string(purpose), hashCode(id, code), httpx.IPString(ip), time.Now().Add(CodeTTL))
	return code, err
}

// VerifyCode checks input against the newest active code and consumes it on success.
// It runs in its own transaction so failed attempts are counted even when the caller's
// later work fails; validate other input before calling it.
func (s *Service) VerifyCode(ctx context.Context, email string, purpose CodePurpose, input string) error {
	var ok bool
	err := database.InTx(ctx, s.db, func(tx pgx.Tx) error {
		var (
			id       uuid.UUID
			hash     []byte
			attempts int
		)
		err := tx.QueryRow(ctx, `
			SELECT id, code_hash, attempts FROM email_codes
			WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
			ORDER BY created_at DESC LIMIT 1
			FOR UPDATE`, email, string(purpose)).Scan(&id, &hash, &attempts)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		code := normalizeCode(input)
		ok = len(code) == codeDigits && subtle.ConstantTimeCompare(hashCode(id, code), hash) == 1
		attempts++
		consume := ok || attempts >= codeMaxAttempts
		_, err = tx.Exec(ctx, `
			UPDATE email_codes
			SET attempts = $2, consumed_at = CASE WHEN $3::boolean THEN now() END
			WHERE id = $1`, id, attempts, consume)
		return err
	})
	if err != nil {
		return err
	}
	if !ok {
		return ErrInvalidCode
	}
	return nil
}
