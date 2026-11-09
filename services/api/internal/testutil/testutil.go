// Package testutil provides isolated PostgreSQL databases for integration tests.
//
// Tests require FUDISLTE_TEST_DATABASE_URL pointing at a server where the role may
// create databases (scripts/wsl/go.sh sets it for the WSL development setup). Each test
// gets a fresh database cloned from a migrated template, so tests never share state.
package testutil

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"

	"fudislte/api/internal/database"
)

var (
	templateOnce sync.Once
	templateName string
	templateErr  error
)

// Main runs a package's tests and removes the template database afterwards.
// Call it from TestMain.
func Main(m *testing.M) {
	code := m.Run()
	if templateName != "" {
		_ = execAdmin(context.Background(), os.Getenv("FUDISLTE_TEST_DATABASE_URL"),
			fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, templateName))
	}
	os.Exit(code)
}

// NewDatabase returns the URL of a new, migrated database that is dropped when the
// test finishes. The test is skipped when no test database server is configured.
func NewDatabase(t *testing.T) string {
	t.Helper()
	base := os.Getenv("FUDISLTE_TEST_DATABASE_URL")
	if base == "" {
		t.Skip("FUDISLTE_TEST_DATABASE_URL is not set; skipping database test")
	}
	templateOnce.Do(func() { templateName, templateErr = createTemplate(base) })
	if templateErr != nil {
		t.Fatalf("create template database: %v", templateErr)
	}
	name := "fudislte_test_" + randomSuffix()
	if err := execAdmin(context.Background(), base, fmt.Sprintf(`CREATE DATABASE %s TEMPLATE %s`, name, templateName)); err != nil {
		t.Fatalf("create test database: %v", err)
	}
	t.Cleanup(func() {
		_ = execAdmin(context.Background(), base, fmt.Sprintf(`DROP DATABASE IF EXISTS %s WITH (FORCE)`, name))
	})
	return withDatabase(base, name)
}

func createTemplate(base string) (string, error) {
	ctx := context.Background()
	name := "fudislte_tmpl_" + randomSuffix()
	if err := execAdmin(ctx, base, `CREATE DATABASE `+name); err != nil {
		return "", err
	}
	if err := database.Migrate(ctx, withDatabase(base, name)); err != nil {
		return "", err
	}
	return name, nil
}

func execAdmin(ctx context.Context, base, sql string) error {
	conn, err := pgx.Connect(ctx, base)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	_, err = conn.Exec(ctx, sql)
	return err
}

func withDatabase(base, name string) string {
	u, err := url.Parse(base)
	if err != nil {
		panic(err)
	}
	u.Path = "/" + name
	return u.String()
}

func randomSuffix() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
