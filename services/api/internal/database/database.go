// Package database owns the PostgreSQL connection pool, transactions and migrations.
package database

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib" // database/sql driver used by goose
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Querier is satisfied by both *pgxpool.Pool and pgx.Tx, so store functions can run
// inside or outside a transaction.
type Querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Pool defaults, used unless the database URL sets them (pool_max_conns=…, or
// options=-c statement_timeout=…). pgx would otherwise allow max(4, CPUs) connections,
// which a small server shares among requests, mail and background jobs.
const (
	defaultMaxConns         = 20
	defaultStatementTimeout = "30s"
)

func Connect(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if !strings.Contains(url, "pool_max_conns") {
		cfg.MaxConns = defaultMaxConns
	}
	// A runaway query fails instead of holding a connection indefinitely.
	if _, set := cfg.ConnConfig.RuntimeParams["statement_timeout"]; !set && !strings.Contains(url, "statement_timeout") {
		cfg.ConnConfig.RuntimeParams["statement_timeout"] = defaultStatementTimeout
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	return pool, nil
}

// InTx runs fn in a transaction that commits when fn returns nil.
func InTx(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error {
	return pgx.BeginFunc(ctx, pool, fn)
}

// Migrate applies all pending migrations. A PostgreSQL session lock makes concurrent
// API replicas wait for each other instead of racing.
func Migrate(ctx context.Context, url string) error {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return err
	}
	defer db.Close()

	fsys, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, fsys, goose.WithSessionLocker(locker))
	if err != nil {
		return err
	}
	results, err := provider.Up(ctx)
	for _, r := range results {
		slog.InfoContext(ctx, "migration applied", "version", r.Source.Version, "duration", r.Duration)
	}
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// IsUniqueViolation reports whether err is a unique constraint violation, optionally
// for a specific constraint name.
func IsUniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		return false
	}
	return constraint == "" || pgErr.ConstraintName == constraint
}
