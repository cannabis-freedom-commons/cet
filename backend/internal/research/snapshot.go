package research

import (
	"bytes"
	"context"
	"errors"
	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/proc"
	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/reportfs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Development edits to the renderer, schema, editorial rules and reports must be
// validated too. Overlay only site inputs, never service state or credentials. The reports go
// into one pack file (reportfs) shared by the workspaces of the same report versions, kept in
// .report-packs beside the workspace: a job reads some ten thousand reports, and as files they
// cost every parallel job that many inodes. Media (public/, src/assets/) no job reads stays out.
func snapshotSite(ctx context.Context, repo, dir string) error {
	allowed := []string{"src", "scripts", "docs", "reports", ".claude/skills", ".opencode/agents", "package.json", "package-lock.json", "astro.config.mjs", "tsconfig.json"}
	cmd := proc.Own(exec.CommandContext(ctx, "git", append([]string{"ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"}, allowed...)...))
	cmd.Dir = repo
	files, err := cmd.Output()
	if err != nil {
		return err
	}
	for _, path := range allowed {
		if err = os.RemoveAll(filepath.Join(dir, path)); err != nil {
			return err
		}
	}
	seen := map[string]bool{}
	var packed []string
	for _, name := range bytes.Split(files, []byte{0}) {
		path := string(name)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		if filepath.IsAbs(path) || strings.HasPrefix(filepath.Clean(path), "..") {
			return errors.New("invalid site snapshot path")
		}
		if strings.HasPrefix(path, "src/assets/") {
			continue
		}
		source := filepath.Join(repo, path)
		info, e := os.Lstat(source)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return errors.New("site snapshot requires regular files")
		}
		// A symlink in any parent must not bring host files into the snapshot.
		for parent := filepath.Dir(path); parent != "."; parent = filepath.Dir(parent) {
			stat, e := os.Lstat(filepath.Join(repo, parent))
			if e != nil {
				return e
			}
			if stat.Mode()&os.ModeSymlink != 0 {
				return errors.New("site snapshot directory is a symlink")
			}
		}
		if strings.HasPrefix(path, "reports/") {
			if strings.HasSuffix(path, ".md") {
				packed = append(packed, filepath.ToSlash(path))
			}
			continue
		}
		target := filepath.Join(dir, path)
		if e = os.MkdirAll(filepath.Dir(target), 0755); e != nil {
			return e
		}
		if e = copyFile(source, target, info.Mode().Perm()); e != nil {
			return e
		}
	}
	return reportfs.Link(repo, packed, filepath.Join(filepath.Dir(dir), ".report-packs"), dir)
}

// copyFile copies one regular file: a copy-on-write clone where the file system has them (APFS),
// which takes no space until either side changes, otherwise its bytes.
func copyFile(source, target string, perm os.FileMode) error {
	if cloneFile(source, target) == nil {
		return os.Chmod(target, perm)
	}
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(target, data, perm)
}
