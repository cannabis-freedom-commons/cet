// Package reportfs reads the report files of a checkout or a research workspace.
//
// A workspace keeps the repository's reports in one file, its pack (reports.zip, an uncompressed
// zip shared by hard link between the workspaces of one commit), instead of some ten thousand
// files per job. What a job writes (its draft, the reports it updates) stays loose under
// reports/ and wins over the pack; a report it moves away is listed in reports.removed. A
// checkout without a pack is read as before: the files under reports/.
package reportfs

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Pack is the file name of a workspace's report pack.
const Pack = "reports.zip"

const removedList = "reports.removed"

// Walk calls fn for every report file of dir (rel is "reports/<year>/<month>/<slug>.md", with
// slashes), in path order. Missing reports (no reports/ folder and no pack) are an error that
// matches fs.ErrNotExist.
func Walk(dir string, fn func(rel string, read func() ([]byte, error)) error) error {
	loose := map[string]string{}
	root := filepath.Join(dir, "reports")
	looseErr := filepath.WalkDir(root, func(p string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			return nil
		}
		if !entry.Type().IsRegular() {
			return errors.New("report files must be regular files: " + p)
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		loose[filepath.ToSlash(rel)] = p
		return nil
	})
	if looseErr != nil && !errors.Is(looseErr, fs.ErrNotExist) {
		return looseErr
	}
	pack, err := zip.OpenReader(filepath.Join(dir, Pack))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("report pack: %w", err)
	}
	if pack == nil && looseErr != nil {
		return looseErr
	}
	packed := map[string]*zip.File{}
	if pack != nil {
		defer pack.Close()
		removed, err := removedPaths(dir)
		if err != nil {
			return err
		}
		for _, f := range pack.File {
			if _, ok := loose[f.Name]; !ok && !removed[f.Name] && !f.FileInfo().IsDir() {
				packed[f.Name] = f
			}
		}
	}
	names := make([]string, 0, len(loose)+len(packed))
	for rel := range loose {
		names = append(names, rel)
	}
	for rel := range packed {
		names = append(names, rel)
	}
	sort.Strings(names)
	for _, rel := range names {
		var read func() ([]byte, error)
		if p, ok := loose[rel]; ok {
			read = func() ([]byte, error) { return os.ReadFile(p) }
		} else {
			f := packed[rel]
			read = func() ([]byte, error) { return readZip(f) }
		}
		if err := fn(rel, read); err != nil {
			return err
		}
	}
	return nil
}

func readZip(f *zip.File) ([]byte, error) {
	r, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(io.LimitReader(r, 64<<20))
}

func removedPaths(dir string) (map[string]bool, error) {
	out := map[string]bool{}
	f, err := os.Open(filepath.Join(dir, removedList))
	if errors.Is(err, fs.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	lines := bufio.NewScanner(f)
	for lines.Scan() {
		if rel := strings.TrimSpace(lines.Text()); rel != "" {
			out[rel] = true
		}
	}
	return out, lines.Err()
}

// Read returns one report file of dir by its relative path.
func Read(dir, rel string) ([]byte, error) {
	rel = path.Clean(filepath.ToSlash(rel))
	if !strings.HasPrefix(rel, "reports/") {
		return nil, errors.New("not a report path: " + rel)
	}
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
	if !errors.Is(err, fs.ErrNotExist) {
		return b, err
	}
	removed, rerr := removedPaths(dir)
	if rerr != nil {
		return nil, rerr
	}
	pack, perr := zip.OpenReader(filepath.Join(dir, Pack))
	if perr != nil || removed[rel] {
		if perr == nil {
			pack.Close()
		}
		return nil, err
	}
	defer pack.Close()
	for _, f := range pack.File {
		if f.Name == rel {
			return readZip(f)
		}
	}
	return nil, err
}

// Find returns the relative path of the report named slug, or "" when there is none; two reports
// with that slug are an error.
func Find(dir, slug string) (string, error) {
	found := ""
	err := Walk(dir, func(rel string, _ func() ([]byte, error)) error {
		if path.Base(rel) == slug+".md" {
			if found != "" {
				return errors.New("ambiguous existing slug")
			}
			found = rel
		}
		return nil
	})
	return found, err
}

// Remove takes a report out of dir: its loose file goes, and a packed copy is listed as removed.
func Remove(dir, rel string) error {
	rel = path.Clean(filepath.ToSlash(rel))
	err := os.Remove(filepath.Join(dir, filepath.FromSlash(rel)))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if _, perr := os.Stat(filepath.Join(dir, Pack)); perr != nil {
		return err // no pack: the loose file was the report
	}
	f, ferr := os.OpenFile(filepath.Join(dir, removedList), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if ferr != nil {
		return ferr
	}
	_, ferr = fmt.Fprintln(f, rel)
	if cerr := f.Close(); ferr == nil {
		ferr = cerr
	}
	return ferr
}

// Link gives the workspace dir the pack of repo's report files (rel paths, with slashes): one pack
// per set of file versions, built once in packs and hard-linked into each workspace (copied where
// links are not possible). Packs of other versions older than an hour are removed; workspaces
// keep theirs through the link.
func Link(repo string, files []string, packs, dir string) error {
	if err := os.MkdirAll(packs, 0700); err != nil {
		return err
	}
	sort.Strings(files)
	sum := sha256.New()
	for _, rel := range files {
		info, err := os.Lstat(filepath.Join(repo, filepath.FromSlash(rel)))
		if err != nil {
			return err
		}
		fmt.Fprintf(sum, "%s\x00%d\x00%d\n", rel, info.Size(), info.ModTime().UnixNano())
	}
	name := hex.EncodeToString(sum.Sum(nil))[:24] + ".zip"
	target := filepath.Join(packs, name)
	if _, err := os.Stat(target); err != nil {
		if err := build(repo, files, packs, target); err != nil {
			return err
		}
	}
	prune(packs, name)
	link := filepath.Join(dir, Pack)
	_ = os.Remove(link)
	_ = os.Remove(filepath.Join(dir, removedList)) // a fresh pack: nothing is removed from it yet
	if os.Link(target, link) == nil {
		return nil
	}
	return copyPack(target, link)
}

func build(repo string, files []string, packs, target string) error {
	tmp, err := os.CreateTemp(packs, ".building-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	w := zip.NewWriter(tmp)
	for _, rel := range files {
		b, err := os.ReadFile(filepath.Join(repo, filepath.FromSlash(rel)))
		if err != nil {
			tmp.Close()
			return err
		}
		// stored, not compressed: reading a report back costs no decompression
		out, err := w.CreateHeader(&zip.FileHeader{Name: rel, Method: zip.Store})
		if err == nil {
			_, err = out.Write(b)
		}
		if err != nil {
			tmp.Close()
			return err
		}
	}
	if err := w.Close(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0444); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}

func prune(packs, keep string) {
	entries, err := os.ReadDir(packs)
	if err != nil {
		return
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || e.Name() == keep || time.Since(info.ModTime()) < time.Hour {
			continue
		}
		_ = os.Remove(filepath.Join(packs, e.Name()))
	}
}

func copyPack(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0444)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
