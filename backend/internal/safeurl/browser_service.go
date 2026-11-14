package safeurl

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/proc"
)

// browserService is one long-lived `node source-browser.mjs --serve`: one Chromium for all
// captures, each in a fresh browser context of its own behind that capture's proxy. Starting a
// browser per page cost a second or more and left Chrome processes behind whenever node went
// away. The process starts with the first capture and again after it ends or dies.
type browserService struct {
	mu      sync.Mutex
	script  string
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	home    string
	next    int64
	pending map[string]chan []byte
	done    chan struct{}
}

var sharedBrowser = &browserService{}

// sharedBrowserEnabled: SOURCE_BROWSER_SHARED=false goes back to one browser per capture.
func sharedBrowserEnabled() bool { return os.Getenv("SOURCE_BROWSER_SHARED") != "false" }

// start runs the server for script unless it already runs; s.mu is held.
func (s *browserService) start(script, cache string) error {
	if s.cmd != nil && s.script == script {
		select {
		case <-s.done:
		default:
			return nil
		}
	}
	s.stopLocked()
	home, err := os.MkdirTemp("", "source-browser-")
	if err != nil {
		return err
	}
	cmd := proc.Own(exec.Command("node", script, "--serve"))
	cmd.Dir = filepath.Dir(script)
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH"), "HOME=" + home, "TMPDIR=" + home, "PLAYWRIGHT_BROWSERS_PATH=" + cache}, blockerEnv()...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		os.RemoveAll(home)
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		os.RemoveAll(home)
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		os.RemoveAll(home)
		return err
	}
	if err := cmd.Start(); err != nil {
		os.RemoveAll(home)
		return err
	}
	done := make(chan struct{})
	s.script, s.cmd, s.stdin, s.home, s.done = script, cmd, stdin, home, done
	s.pending = map[string]chan []byte{}
	pending := s.pending
	go func() {
		lines := bufio.NewScanner(stderr)
		lines.Buffer(make([]byte, 64*1024), 1024*1024)
		for lines.Scan() {
			slog.Debug("source browser", "line", lines.Text())
		}
	}()
	go func() {
		lines := bufio.NewScanner(stdout)
		lines.Buffer(make([]byte, 64*1024), 16*1024*1024)
		for lines.Scan() {
			var head struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(lines.Bytes(), &head) != nil || head.ID == "" {
				continue
			}
			line := append([]byte(nil), lines.Bytes()...)
			s.mu.Lock()
			reply := pending[head.ID]
			delete(pending, head.ID)
			s.mu.Unlock()
			if reply != nil {
				reply <- line
			}
		}
		err := cmd.Wait()
		// Playwright starts Chromium detached; if node died without closing it, its profile in
		// this server's own home still names it
		proc.KillMatching(home)
		os.RemoveAll(home)
		s.mu.Lock()
		for id, reply := range pending {
			close(reply) // the captures still waiting get no answer: the process ended
			delete(pending, id)
		}
		s.mu.Unlock()
		close(done)
		if err != nil {
			slog.Warn("the source browser stopped; the next capture starts it again", "error", err)
		}
	}()
	return nil
}

// stopLocked ends the server: closing stdin lets it close its browser and exit.
func (s *browserService) stopLocked() {
	if s.cmd == nil {
		return
	}
	if s.stdin != nil {
		s.stdin.Close()
	}
	s.cmd, s.stdin = nil, nil
}

// capture sends one request and returns its answer channel, closed without an answer if the
// server ends first.
func (s *browserService) capture(script, cache string, request map[string]string) (string, <-chan []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.start(script, cache); err != nil {
		return "", nil, err
	}
	s.next++
	id := strconv.FormatInt(s.next, 10)
	request["id"] = id
	line, _ := json.Marshal(request)
	reply := make(chan []byte, 1)
	s.pending[id] = reply
	if _, err := s.stdin.Write(append(line, '\n')); err != nil {
		delete(s.pending, id)
		s.stopLocked()
		return "", nil, errors.New("the source browser could not be reached")
	}
	return id, reply, nil
}

// cancel stops a capture whose caller gave up: its browser context closes.
func (s *browserService) cancel(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, id)
	if s.stdin != nil {
		line, _ := json.Marshal(map[string]string{"cancel": id})
		_, _ = s.stdin.Write(append(line, '\n'))
	}
}

func blockerEnv() []string {
	var env []string
	// the ad and cookie-notice blocker's switch and engine cache (scripts/source-browser.mjs)
	for _, key := range []string{"SOURCE_ADBLOCK", "SOURCE_BLOCKER_CACHE", "SOURCE_BLOCKER_DEBUG"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	return env
}
