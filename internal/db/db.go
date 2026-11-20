// Package db connects to PostgreSQL and applies schema migrations.
//
// Queries in this code base are written with `?` placeholders; DB rewrites
// them to PostgreSQL's `$1, $2…` and stores Go bools as 0/1 (flag columns are
// integers), so call sites stay short.
package db

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// DB wraps *sql.DB with placeholder rewriting. Use it like *sql.DB.
type DB struct {
	*sql.DB
}

// Tx wraps *sql.Tx the same way.
type Tx struct {
	*sql.Tx
}

// Open connects to the database at dsn (postgres://user:pass@host:5432/db?sslmode=disable)
// and migrates it to the latest schema.
func Open(ctx context.Context, dsn string) (*DB, error) {
	d, err := Connect(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if _, err := Migrate(ctx, d); err != nil {
		d.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

// Connect opens the pool without migrating (for `migrate status`).
func Connect(ctx context.Context, dsn string) (*DB, error) {
	if dsn == "" {
		return nil, errors.New("thiếu DATABASE_URL (vd postgres://rii:mat-khau@localhost:5432/rii_music?sslmode=disable)")
	}
	sqldb, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	sqldb.SetMaxOpenConns(10)
	sqldb.SetMaxIdleConns(5)
	sqldb.SetConnMaxIdleTime(5 * time.Minute)
	// The database may still be starting (docker compose): retry for a while.
	var perr error
	for i := 0; i < 30; i++ {
		pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		perr = sqldb.PingContext(pctx)
		cancel()
		if perr == nil {
			return &DB{sqldb}, nil
		}
		select {
		case <-ctx.Done():
			sqldb.Close()
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	sqldb.Close()
	return nil, fmt.Errorf("kết nối PostgreSQL: %w", perr)
}

// Rebind turns `?` placeholders into `$1, $2…` (outside quoted strings).
func Rebind(q string) string {
	if !strings.Contains(q, "?") {
		return q
	}
	var b strings.Builder
	b.Grow(len(q) + 16)
	n := 0
	inStr := false
	for i := 0; i < len(q); i++ {
		c := q[i]
		switch {
		case c == '\'':
			inStr = !inStr
			b.WriteByte(c)
		case c == '?' && !inStr:
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// args stores bools as 0/1 (flag columns are integers) and repairs invalid
// UTF-8 (PostgreSQL rejects it; tool output can carry it).
func args(a []any) []any {
	for i, v := range a {
		switch x := v.(type) {
		case string:
			if !utf8.ValidString(x) {
				a[i] = strings.ToValidUTF8(x, "�")
			}
		case bool:
			if x {
				a[i] = 1
			} else {
				a[i] = 0
			}
		}
	}
	return a
}

func (d *DB) Exec(q string, a ...any) (sql.Result, error) {
	return d.DB.Exec(Rebind(q), args(a)...)
}
func (d *DB) Query(q string, a ...any) (*sql.Rows, error) {
	return d.DB.Query(Rebind(q), args(a)...)
}
func (d *DB) QueryRow(q string, a ...any) *sql.Row {
	return d.DB.QueryRow(Rebind(q), args(a)...)
}
func (d *DB) ExecContext(ctx context.Context, q string, a ...any) (sql.Result, error) {
	return d.DB.ExecContext(ctx, Rebind(q), args(a)...)
}
func (d *DB) QueryContext(ctx context.Context, q string, a ...any) (*sql.Rows, error) {
	return d.DB.QueryContext(ctx, Rebind(q), args(a)...)
}
func (d *DB) QueryRowContext(ctx context.Context, q string, a ...any) *sql.Row {
	return d.DB.QueryRowContext(ctx, Rebind(q), args(a)...)
}
func (d *DB) Begin() (*Tx, error) {
	tx, err := d.DB.Begin()
	if err != nil {
		return nil, err
	}
	return &Tx{tx}, nil
}
func (d *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*Tx, error) {
	tx, err := d.DB.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &Tx{tx}, nil
}

func (t *Tx) Exec(q string, a ...any) (sql.Result, error) {
	return t.Tx.Exec(Rebind(q), args(a)...)
}
func (t *Tx) Query(q string, a ...any) (*sql.Rows, error) {
	return t.Tx.Query(Rebind(q), args(a)...)
}
func (t *Tx) QueryRow(q string, a ...any) *sql.Row {
	return t.Tx.QueryRow(Rebind(q), args(a)...)
}
func (t *Tx) ExecContext(ctx context.Context, q string, a ...any) (sql.Result, error) {
	return t.Tx.ExecContext(ctx, Rebind(q), args(a)...)
}

// ── migrations ──────────────────────────────────────────────────────────

//go:embed migrations/*.sql
var migrationFS embed.FS

// Migration is one numbered schema change (migrations/NNNN_name.sql).
type Migration struct {
	Version int
	Name    string
	SQL     string
}

// Status of a migration in a database.
type Status struct {
	Migration
	AppliedAt time.Time // zero: pending
}

// Migrations lists the embedded migrations in order.
func Migrations() ([]Migration, error) {
	entries, err := fs.ReadDir(migrationFS, "migrations")
	if err != nil {
		return nil, err
	}
	var out []Migration
	for _, e := range entries {
		name := e.Name()
		num, rest, ok := strings.Cut(strings.TrimSuffix(name, ".sql"), "_")
		v, err := strconv.Atoi(num)
		if !ok || err != nil || v <= 0 {
			return nil, fmt.Errorf("tên migration không hợp lệ: %s (cần NNNN_ten.sql)", name)
		}
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return nil, err
		}
		out = append(out, Migration{Version: v, Name: rest, SQL: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	for i := range out {
		if out[i].Version != i+1 {
			return nil, fmt.Errorf("migration thiếu số %d", i+1)
		}
	}
	return out, nil
}

// lockKey: pg_advisory_lock id so two server processes never migrate at once.
const lockKey = 0x52_69_69_4d // "RiiM"

const createTable = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`

// Migrate applies the pending migrations, each in its own transaction, under
// an advisory lock. It returns the versions applied.
func Migrate(ctx context.Context, d *DB) ([]int, error) {
	ms, err := Migrations()
	if err != nil {
		return nil, err
	}
	conn, err := d.DB.Conn(ctx) // the advisory lock belongs to one session
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, lockKey); err != nil {
		return nil, err
	}
	defer conn.ExecContext(context.Background(), `SELECT pg_advisory_unlock($1)`, lockKey)
	if _, err := conn.ExecContext(ctx, createTable); err != nil {
		return nil, err
	}
	applied := map[int]bool{}
	rows, err := conn.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var v int
		if rows.Scan(&v) == nil {
			applied[v] = true
		}
	}
	rows.Close()
	if len(applied) > len(ms) {
		return nil, fmt.Errorf("cơ sở dữ liệu có %d migration, bản này chỉ biết %d: đang chạy bản cũ hơn cơ sở dữ liệu?", len(applied), len(ms))
	}
	var done []int
	for _, m := range ms {
		if applied[m.Version] {
			continue
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return done, err
		}
		if _, err := tx.ExecContext(ctx, m.SQL); err != nil {
			tx.Rollback()
			return done, fmt.Errorf("migration %04d_%s: %w", m.Version, m.Name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations(version, name) VALUES ($1, $2)`, m.Version, m.Name); err != nil {
			tx.Rollback()
			return done, err
		}
		if err := tx.Commit(); err != nil {
			return done, err
		}
		done = append(done, m.Version)
	}
	return done, nil
}

// MigrationStatus reports which migrations are applied (without changing anything).
func MigrationStatus(ctx context.Context, d *DB) ([]Status, error) {
	ms, err := Migrations()
	if err != nil {
		return nil, err
	}
	at := map[int]time.Time{}
	var exists bool
	d.DB.QueryRowContext(ctx, `SELECT to_regclass('schema_migrations') IS NOT NULL`).Scan(&exists)
	if exists {
		rows, err := d.DB.QueryContext(ctx, `SELECT version, applied_at FROM schema_migrations`)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var v int
			var t time.Time
			if rows.Scan(&v, &t) == nil {
				at[v] = t
			}
		}
		rows.Close()
	}
	out := make([]Status, len(ms))
	for i, m := range ms {
		out[i] = Status{Migration: m, AppliedAt: at[m.Version]}
	}
	return out, nil
}

// IsUniqueViolation: the error is a duplicate key (SQLSTATE 23505).
func IsUniqueViolation(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}
