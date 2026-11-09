// Package storage keeps attachment bytes (ADR-0009). Disk is the only backend today; an
// S3-compatible one can implement Store when several API replicas share files.
package storage

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// ErrTooLarge is returned by Put when the content exceeds the size limit.
var ErrTooLarge = errors.New("storage: file too large")

// Stored describes content written by Put.
type Stored struct {
	Size   int64
	SHA256 []byte
	// Head holds the first bytes, for content-type detection.
	Head []byte
}

type Store interface {
	Put(orgID, fileID uuid.UUID, r io.Reader, maxBytes int64) (Stored, error)
	Open(orgID, fileID uuid.UUID) (*os.File, error)
	Delete(orgID, fileID uuid.UUID) error
}

// Disk stores files as root/files/{orgID}/{fileID}. Keys are UUIDs, so paths cannot
// escape the root.
type Disk struct {
	root string
}

func NewDisk(root string) (*Disk, error) {
	dir := filepath.Join(root, "files")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("storage: create %s: %w", dir, err)
	}
	return &Disk{root: dir}, nil
}

func (d *Disk) path(orgID, fileID uuid.UUID) string {
	return filepath.Join(d.root, orgID.String(), fileID.String())
}

// Put streams r to disk through a temporary file, so a failed or oversized upload never
// leaves a partial file behind.
func (d *Disk) Put(orgID, fileID uuid.UUID, r io.Reader, maxBytes int64) (Stored, error) {
	dir := filepath.Join(d.root, orgID.String())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Stored{}, err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return Stored{}, err
	}
	defer os.Remove(tmp.Name()) // no-op after the rename

	hash := sha256.New()
	head := &headWriter{limit: 512}
	n, err := io.Copy(io.MultiWriter(tmp, hash, head), io.LimitReader(r, maxBytes+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return Stored{}, err
	}
	if n > maxBytes {
		return Stored{}, ErrTooLarge
	}
	if err := os.Rename(tmp.Name(), d.path(orgID, fileID)); err != nil {
		return Stored{}, err
	}
	return Stored{Size: n, SHA256: hash.Sum(nil), Head: head.buf}, nil
}

func (d *Disk) Open(orgID, fileID uuid.UUID) (*os.File, error) {
	return os.Open(d.path(orgID, fileID))
}

// Delete removes a file; a file that is already gone is not an error.
func (d *Disk) Delete(orgID, fileID uuid.UUID) error {
	err := os.Remove(d.path(orgID, fileID))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

type headWriter struct {
	buf   []byte
	limit int
}

func (h *headWriter) Write(p []byte) (int, error) {
	if room := h.limit - len(h.buf); room > 0 {
		h.buf = append(h.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}
