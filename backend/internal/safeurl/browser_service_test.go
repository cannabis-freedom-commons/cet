package safeurl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The shared browser's server answers each capture by its id, hears cancellations, and starts again
// after it dies. A fake server stands in for node and Chromium.
func TestBrowserServiceAnswersByIDAndRestarts(t *testing.T) {
	dir := t.TempDir()
	cancels := filepath.Join(dir, "cancels")
	script := filepath.Join(dir, "fake.mjs")
	// answers in reverse order of arrival for two requests; "die" ends the process
	body := `import { createInterface } from "node:readline";
import fs from "node:fs";
const held = [];
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.cancel) { fs.appendFileSync(` + "`" + cancels + "`" + `, m.cancel + "\n"); continue; }
  if (m.url === "die") process.exit(3);
  if (m.url === "hold") { held.push(m); continue; }
  for (const h of [m, ...held.splice(0)]) process.stdout.write(JSON.stringify({ id: h.id, evidence: { url: h.url } }) + "\n");
}
`
	if err := os.WriteFile(script, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	s := &browserService{}
	_, held, err := s.capture(script, dir, map[string]string{"url": "hold"})
	if err != nil {
		t.Fatal(err)
	}
	_, now, _ := s.capture(script, dir, map[string]string{"url": "now"})
	for name, reply := range map[string]<-chan []byte{"now": now, "hold": held} {
		select {
		case line := <-reply:
			if !strings.Contains(string(line), `"url":"`+name+`"`) {
				t.Fatalf("%s got another capture's answer: %s", name, line)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("no answer for", name)
		}
	}
	id, _, _ := s.capture(script, dir, map[string]string{"url": "hold"})
	s.cancel(id)
	_, died, _ := s.capture(script, dir, map[string]string{"url": "die"})
	select {
	case _, ok := <-died:
		if ok {
			t.Fatal("a capture of a dead server got an answer")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a dead server left its capture waiting")
	}
	if b, _ := os.ReadFile(cancels); strings.TrimSpace(string(b)) != id {
		t.Fatalf("the cancellation did not reach the server: %q", b)
	}
	<-s.done
	_, again, err := s.capture(script, dir, map[string]string{"url": "again"})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case line := <-again:
		if !strings.Contains(string(line), `"again"`) {
			t.Fatal(string(line))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the server did not start again")
	}
	s.mu.Lock()
	s.stopLocked()
	s.mu.Unlock()
}
