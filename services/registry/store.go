package main

import (
	"cmp"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// Instance is one FUDISLTE server whose administrator agreed to register it. These are
// all the fields there are: nothing else is received or kept.
type Instance struct {
	ID               string    `json:"id"`
	SecretHash       string    `json:"secretHash"`
	OrganizationName string    `json:"organizationName"`
	ContactEmail     string    `json:"contactEmail"`
	UserCount        int       `json:"userCount"`
	Version          string    `json:"version"`
	FirstSeen        time.Time `json:"firstSeen"`
	LastSeen         time.Time `json:"lastSeen"`
}

var (
	errWrongSecret = errors.New("the secret does not match this instance")
	errFull        = errors.New("the registry is full")
)

// Store keeps instances in one JSON file, rewritten atomically. Reports are written
// together every few seconds (Run), not one rewrite per report; a withdrawal is written
// before it is confirmed. A crash can lose only the latest reports, which their servers
// send again the next day.
type Store struct {
	mu    sync.Mutex
	path  string
	max   int
	byID  map[string]*Instance
	dirty bool
}

func OpenStore(dir string, max int) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "instances.json"), max: max, byID: map[string]*Instance{}}
	b, err := os.ReadFile(s.path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		var list []*Instance
		if err := json.Unmarshal(b, &list); err != nil {
			return nil, fmt.Errorf("%s: %w", s.path, err)
		}
		for _, in := range list {
			s.byID[in.ID] = in
		}
	}
	return s, nil
}

func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func secretMatches(in *Instance, secret string) bool {
	return subtle.ConstantTimeCompare([]byte(in.SecretHash), []byte(hashSecret(secret))) == 1
}

// Upsert registers a new instance, or refreshes one when the report carries the secret it
// registered with, so nobody else can overwrite or remove it.
func (s *Store) Upsert(r Report, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	in, exists := s.byID[r.InstanceID]
	if exists {
		if !secretMatches(in, r.Secret) {
			return errWrongSecret
		}
	} else {
		if len(s.byID) >= s.max {
			return errFull
		}
		in = &Instance{ID: r.InstanceID, SecretHash: hashSecret(r.Secret), FirstSeen: now}
		s.byID[r.InstanceID] = in
	}
	in.OrganizationName, in.ContactEmail, in.UserCount, in.Version, in.LastSeen =
		r.OrganizationName, r.ContactEmail, r.UserCount, r.Version, now
	s.dirty = true
	return nil
}

// Flush writes pending reports to disk.
func (s *Store) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty {
		return nil
	}
	if err := s.save(); err != nil {
		return err
	}
	s.dirty = false
	return nil
}

// Run flushes every interval until ctx ends, then once more.
func (s *Store) Run(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			if err := s.Flush(); err != nil {
				slog.Error("registry: save on shutdown", "error", err)
			}
			return
		case <-t.C:
			if err := s.Flush(); err != nil {
				slog.Error("registry: save", "error", err) // retried on the next tick
			}
		}
	}
}

// Delete removes an instance whose administrator withdrew. Unknown IDs are not an error.
func (s *Store) Delete(id, secret string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	in, ok := s.byID[id]
	if !ok {
		return nil
	}
	if !secretMatches(in, secret) {
		return errWrongSecret
	}
	delete(s.byID, id)
	// Written now: a confirmed withdrawal must not come back after a crash. Pending
	// reports go with it.
	if err := s.save(); err != nil {
		s.byID[id] = in
		return err
	}
	s.dirty = false
	return nil
}

// List returns copies of every instance, most recently heard from first.
func (s *Store) List() []Instance {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Instance, 0, len(s.byID))
	for _, in := range s.byID {
		out = append(out, *in)
	}
	slices.SortFunc(out, func(a, b Instance) int {
		return cmp.Or(b.LastSeen.Compare(a.LastSeen), cmp.Compare(a.ID, b.ID))
	})
	return out
}

func (s *Store) save() error {
	list := make([]*Instance, 0, len(s.byID))
	for _, in := range s.byID {
		list = append(list, in)
	}
	slices.SortFunc(list, func(a, b *Instance) int { return cmp.Compare(a.ID, b.ID) })
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), "instances-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op after a successful rename
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path)
}
