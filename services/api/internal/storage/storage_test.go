package storage

import (
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestDiskPutOpenDelete(t *testing.T) {
	d, err := NewDisk(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	org, file := uuid.New(), uuid.New()
	content := strings.Repeat("fudislte ", 200)
	stored, err := d.Put(org, file, strings.NewReader(content), 10_000)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(content))
	if stored.Size != int64(len(content)) || string(stored.SHA256) != string(sum[:]) || len(stored.Head) != 512 {
		t.Fatalf("stored = %d bytes, head %d", stored.Size, len(stored.Head))
	}
	f, err := d.Open(org, file)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(f)
	f.Close()
	if string(got) != content {
		t.Fatal("content differs")
	}
	if err := d.Delete(org, file); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Open(org, file); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("after delete: %v", err)
	}
	if err := d.Delete(org, file); err != nil {
		t.Fatalf("deleting twice: %v", err)
	}
}

func TestDiskRejectsOversizedFiles(t *testing.T) {
	root := t.TempDir()
	d, _ := NewDisk(root)
	org, file := uuid.New(), uuid.New()
	if _, err := d.Put(org, file, strings.NewReader(strings.Repeat("x", 101)), 100); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
	entries, _ := os.ReadDir(d.root + "/" + org.String())
	if len(entries) != 0 {
		t.Fatalf("left %d files behind", len(entries))
	}
}
