package reportfs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func list(t *testing.T, dir string) string {
	t.Helper()
	var out []string
	if err := Walk(dir, func(rel string, read func() ([]byte, error)) error {
		b, err := read()
		out = append(out, rel+"="+string(b))
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return strings.Join(out, " ")
}

// A workspace reads the repository's reports from one shared pack; what the job writes is loose
// and wins, and a report it moves away is gone from its view.
func TestPackedWorkspace(t *testing.T) {
	repo, root := t.TempDir(), t.TempDir()
	write(t, repo, "reports/2020/01/a.md", "a1")
	write(t, repo, "reports/2021/02/b.md", "b1")
	packs := filepath.Join(root, ".report-packs")
	dir, other := filepath.Join(root, "job-1"), filepath.Join(root, "job-2")
	for _, d := range []string{dir, other} {
		os.MkdirAll(d, 0755)
		if err := Link(repo, []string{"reports/2020/01/a.md", "reports/2021/02/b.md"}, packs, d); err != nil {
			t.Fatal(err)
		}
	}
	if packsMade, _ := os.ReadDir(packs); len(packsMade) != 1 {
		t.Fatalf("one pack for one version of the reports, got %d", len(packsMade))
	}
	if got := list(t, dir); got != "reports/2020/01/a.md=a1 reports/2021/02/b.md=b1" {
		t.Fatal(got)
	}
	write(t, dir, "reports/2020/01/a.md", "a2")
	write(t, dir, "reports/2022/03/c.md", "c1")
	if err := Remove(dir, "reports/2021/02/b.md"); err != nil {
		t.Fatal(err)
	}
	if got := list(t, dir); got != "reports/2020/01/a.md=a2 reports/2022/03/c.md=c1" {
		t.Fatal(got)
	}
	if b, err := Read(dir, "reports/2021/02/b.md"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a removed report is still read: %q %v", b, err)
	}
	if b, _ := Read(other, "reports/2021/02/b.md"); string(b) != "b1" {
		t.Fatal("another workspace's view changed")
	}
	if rel, err := Find(dir, "c"); err != nil || rel != "reports/2022/03/c.md" {
		t.Fatal(rel, err)
	}
	write(t, dir, "reports/2023/04/a.md", "again")
	if _, err := Find(dir, "a"); err == nil {
		t.Fatal("two reports with one slug must be an error")
	}
}

// A checkout without a pack is read from its files; without reports at all, Walk says so.
func TestLooseCheckout(t *testing.T) {
	dir := t.TempDir()
	if err := Walk(dir, func(string, func() ([]byte, error)) error { return nil }); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	write(t, dir, "reports/2020/01/a.md", "a1")
	if got := list(t, dir); got != "reports/2020/01/a.md=a1" {
		t.Fatal(got)
	}
}
