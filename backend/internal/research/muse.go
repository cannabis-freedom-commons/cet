package research

// The Muse runtime: research agents named "muse@model" in RESEARCH_AGENTS (recorded as
// "muse/model#effort") run on Meta's Muse coding agent instead of OpenCode, always in Muse's
// contributor mode.
//
// Everything else in this package speaks OpenCode: it builds `opencode run --agent … --model …
// --format json <prompt>` (with --continue for a correction), reads OpenCode's JSON events for the
// public chat, the step count, the tokens and the pages fetched, and takes the final answer from
// them. So for a Muse model, commandArgs starts this same program as a bridge (MuseBridge, chosen
// by an environment variable) with those OpenCode arguments, inside the same macOS sandbox. The
// bridge talks to `muse acp` (the Agent Client Protocol, which carries every tool call's input,
// the model's messages and its reasoning), opens or continues the job's Muse session with the
// agent's instructions and the tracker's tool server, takes each model step's tokens from Muse's
// session log, stops the turn at the agent's step limit, and writes it all out as the OpenCode
// events the rest of the package already reads.

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/frontmatter"
	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/proc"
	"gopkg.in/yaml.v3"
)

// MuseProvider is the provider part of a Muse model's id ("muse/muse-spark-1.3#xhigh").
const MuseProvider = "muse"

// MuseBridgeEnv, set in a command's environment, makes this program the Muse bridge.
const MuseBridgeEnv = "TRACKER_MUSE_BRIDGE"

func isMuse(model string) bool { return strings.HasPrefix(model, MuseProvider+"/") }

// museCommand prepares the bridge for a Muse model: a private home with Muse's own settings and
// the account's saved login (its secret stays in the macOS keychain, which the home links to), in
// the sandbox OpenCode runs in.
func (r Runner) museCommand(ctx context.Context, input string, args []string) (*exec.Cmd, func(), error) {
	if r.Config.ResearchRunner != "local" || runtime.GOOS != "darwin" {
		return nil, nil, errors.New("the Muse runtime runs only with the local runner on macOS")
	}
	name := r.Config.MuseBinary
	if name == "" {
		name = "muse"
	}
	muse, err := exec.LookPath(name)
	if err != nil {
		return nil, nil, errors.New("Muse executable not available; install it or set MUSE_BIN")
	}
	if muse, err = museExecutable(muse); err != nil {
		return nil, nil, err
	}
	self, err := os.Executable()
	if err != nil {
		return nil, nil, err
	}
	if self, err = filepath.EvalSymlinks(self); err != nil {
		return nil, nil, err
	}
	resuming := r.resumeHome != ""
	home := r.resumeHome
	if !resuming {
		if home, err = os.MkdirTemp(filepath.Dir(input), ".muse-session-"); err != nil {
			return nil, nil, err
		}
	}
	prepared := false
	defer func() {
		if !prepared && !resuming {
			_ = os.RemoveAll(home)
		}
	}()
	for _, path := range []string{"config/muse", "data", "cache", "state", "tmp", "Library"} {
		if err = os.MkdirAll(filepath.Join(home, path), 0700); err != nil {
			return nil, nil, err
		}
	}
	keychains := filepath.Join(userHome(), "Library", "Keychains")
	if !resuming {
		auth, err := os.ReadFile(filepath.Join(museUserConfig(), "auth.json"))
		if err != nil {
			return nil, nil, errors.New("no saved Muse login: run `muse login` on this machine")
		}
		if err = os.WriteFile(filepath.Join(home, "config", "muse", "auth.json"), auth, 0600); err != nil {
			return nil, nil, err
		}
		// the login's secret is in the keychain, found through the home folder
		if err = os.Symlink(keychains, filepath.Join(home, "Library", "Keychains")); err != nil {
			return nil, nil, err
		}
	}
	if r.tool != nil {
		if err = addCheckTool(input, r.tool, false); err != nil {
			return nil, nil, err
		}
	}
	// Muse looks for project MCP settings in every folder above the workspace and turns its tool
	// servers off when one cannot be opened: those folders may be listed, their files stay closed.
	ancestors := ""
	for dir := filepath.Dir(input); ; dir = filepath.Dir(dir) {
		ancestors += " (literal " + strconv.Quote(dir) + ")"
		if dir == filepath.Dir(dir) {
			break
		}
	}
	profile := `(version 1)
(allow default)
; As for OpenCode: no host user or job data, except the job's input, its private home and the
; keychain that holds the Muse login.
(deny file-read* file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders") (subpath "/private/tmp") (subpath "/private/var/root") (subpath "/var/lib") (subpath "/private/var/lib"))
(allow file-read-metadata)
(allow file-read* (literal ` + strconv.Quote(self) + `) (literal ` + strconv.Quote(muse) + `) (subpath ` + strconv.Quote(input) + `) (subpath ` + strconv.Quote(home) + `) (subpath ` + strconv.Quote(keychains) + `)` + ancestors + `)
(allow file-write* (subpath ` + strconv.Quote(home) + `))
`
	profilePath := filepath.Join(home, "profile.sb")
	if err = os.WriteFile(profilePath, []byte(profile), 0600); err != nil {
		return nil, nil, err
	}
	cmd := proc.Own(exec.CommandContext(ctx, "/usr/bin/sandbox-exec", append([]string{"-f", profilePath, self}, args...)...))
	cmd.Dir = input
	cmd.Env = []string{MuseBridgeEnv + "=" + muse, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + home, "TMPDIR=" + filepath.Join(home, "tmp"), "XDG_CONFIG_HOME=" + filepath.Join(home, "config"), "XDG_DATA_HOME=" + filepath.Join(home, "data"), "XDG_CACHE_HOME=" + filepath.Join(home, "cache"), "XDG_STATE_HOME=" + filepath.Join(home, "state"), "CI=true", "NO_COLOR=1"}
	prepared = true
	return cmd, func() { _ = os.RemoveAll(home) }, nil
}

// museExecutable: the Muse program itself. The installed `muse` is a launcher script that updates
// itself and runs muse-bin-<version> beside it (named in .muse-version); the sandbox runs that
// binary directly, so nothing updates during a run.
func museExecutable(path string) (string, error) {
	path, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(path)
	if b, err := os.ReadFile(filepath.Join(dir, ".muse-version")); err == nil {
		version := strings.TrimSpace(string(b))
		if regexp.MustCompile(`^[0-9A-Za-z.+-]{1,60}$`).MatchString(version) {
			binary := filepath.Join(dir, "muse-bin-"+version)
			if info, err := os.Stat(binary); err == nil && info.Mode().IsRegular() && info.Mode()&0111 != 0 {
				return binary, nil
			}
		}
	}
	return path, nil
}

// the person's Muse settings folder
func museUserConfig() string {
	if base := os.Getenv("XDG_CONFIG_HOME"); base != "" {
		return filepath.Join(base, "muse")
	}
	return filepath.Join(userHome(), ".config", "muse")
}

// MuseBridge runs one OpenCode-style invocation on Muse (see the top of this file) and returns
// its exit code. It runs inside the sandbox, in the job's input folder.
func MuseBridge(muse string, args []string) int {
	if len(args) == 1 && args[0] == "--version" {
		cmd := exec.Command(muse, "--version")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if cmd.Run() != nil {
			return 1
		}
		return 0
	}
	call, err := parseOpenCodeArgs(args)
	if err == nil {
		var turn museTurn
		if turn, err = call.museTurn(); err == nil {
			return runMuse(muse, turn)
		}
	}
	fmt.Fprintln(os.Stderr, "muse bridge:", err)
	return 2
}

// what an OpenCode command line asked for
type openCodeCall struct {
	agent, model, prompt string
	continued            bool
}

func parseOpenCodeArgs(args []string) (openCodeCall, error) {
	var c openCodeCall
	if len(args) < 2 || args[0] != "run" {
		return c, errors.New("unsupported command")
	}
	for i := 1; i < len(args)-1; i++ {
		switch args[i] {
		case "--agent":
			i++
			c.agent = args[i]
		case "--model":
			i++
			c.model = args[i]
		case "--format":
			i++
		case "--continue":
			c.continued = true
		}
	}
	c.prompt = args[len(args)-1]
	if c.agent == "" || !isMuse(c.model) {
		return c, errors.New("an agent and a muse/ model are required")
	}
	return c, nil
}

// museTurn is one turn of a Muse session: `muse acp` started with args, the session to continue
// ("" for a new one), the prompt, the step limit and the tool servers.
type museTurn struct {
	args            []string
	session, idFile string
	prompt, cwd     string
	home            string
	steps           int
	mcp             []map[string]any
}

// museTurn: the turn for the call. A new session opens with the agent's instructions; a
// correction continues the agent's session with the feedback alone.
func (c openCodeCall) museTurn() (museTurn, error) {
	home := os.Getenv("HOME")
	model, effort, _ := strings.Cut(strings.TrimPrefix(c.model, MuseProvider+"/"), "#")
	instructions, steps, err := agentInstructions(c.agent)
	if err != nil {
		return museTurn{}, err
	}
	wd, _ := os.Getwd()
	t := museTurn{prompt: c.prompt, cwd: wd, home: home, steps: steps, idFile: filepath.Join(home, "muse-session-"+c.agent), mcp: museServers()}
	if id, err := os.ReadFile(t.idFile); c.continued && err == nil {
		t.session = strings.TrimSpace(string(id))
	}
	if t.session == "" {
		t.prompt = instructions + "\n\n---\n\n" + c.prompt
	}
	// the reasoning effort is a setting of Muse's, per model
	settings := map[string]any{"schema_version": 1, "model": model}
	if effort != "" {
		settings["model_reasoning_efforts"] = map[string]string{model: effort}
	}
	b, _ := json.Marshal(settings)
	if err = os.WriteFile(filepath.Join(home, "config", "muse", "settings.json"), b, 0600); err != nil {
		return museTurn{}, err
	}
	// Muse starts tool servers only in a trusted workspace: the job's input folder, which holds
	// nothing but what the worker wrote there
	b, _ = json.Marshal(map[string]any{"schema_version": 1, "projects": map[string]any{wd: map[string]string{"decision": "trusted"}}})
	if err = os.WriteFile(filepath.Join(home, "config", "muse", "trust.json"), b, 0600); err != nil {
		return museTurn{}, err
	}
	// read-only research in contributor mode: no writing, no shell, nothing to ask
	t.args = []string{"acp", "--model", model, "--contributor-mode", "on", "--disable-write", "--disable-shell", "--disable-request-user-input"}
	return t, nil
}

// agentInstructions: an agent's instructions and step limit, from opencode.json (the probe and
// screen agents) or .opencode/agents/<agent>.md (the researcher)
func agentInstructions(agent string) (string, int, error) {
	var cfg struct {
		Agent map[string]struct {
			Prompt string `json:"prompt"`
			Steps  int    `json:"steps"`
		} `json:"agent"`
	}
	if b, err := os.ReadFile("opencode.json"); err == nil && json.Unmarshal(b, &cfg) == nil {
		if a, ok := cfg.Agent[agent]; ok && a.Prompt != "" {
			return a.Prompt, a.Steps, nil
		}
	}
	if !regexp.MustCompile(`^[a-z][a-z0-9-]{0,60}$`).MatchString(agent) {
		return "", 0, errors.New("invalid agent name")
	}
	b, err := os.ReadFile(filepath.Join(".opencode", "agents", agent+".md"))
	if err != nil {
		return "", 0, fmt.Errorf("agent %s has no instructions", agent)
	}
	parts := frontmatter.Split(string(b))
	if len(parts) != 3 {
		return "", 0, errors.New("research agent instructions are invalid")
	}
	var header struct {
		Steps int `yaml:"steps"`
	}
	_ = yaml.Unmarshal([]byte(parts[1]), &header)
	return strings.TrimSpace(parts[2]), header.Steps, nil
}

// museServers: the tool servers named in opencode.json (the tracker's check tool), as ACP takes them
func museServers() []map[string]any {
	var cfg struct {
		MCP map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcp"`
	}
	if b, err := os.ReadFile("opencode.json"); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	servers := []map[string]any{}
	for name, s := range cfg.MCP {
		if s.Type != "remote" || s.URL == "" {
			continue
		}
		headers := []map[string]string{}
		for k, v := range s.Headers {
			headers = append(headers, map[string]string{"name": k, "value": v})
		}
		servers = append(servers, map[string]any{"type": "http", "name": name, "url": s.URL, "headers": headers})
	}
	return servers
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// acpClient speaks JSON-RPC with `muse acp` over its stdin and stdout.
type acpClient struct {
	in      io.Writer
	mu      sync.Mutex
	next    int
	waiting map[int]chan acpMessage
	updates func(json.RawMessage)
}

type acpMessage struct {
	ID     *int            `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func (c *acpClient) write(v any) {
	b, _ := json.Marshal(v)
	c.mu.Lock()
	_, _ = c.in.Write(append(b, '\n'))
	c.mu.Unlock()
}

// call sends a request and waits for its answer
func (c *acpClient) call(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.next++
	id, wait := c.next, make(chan acpMessage, 1)
	c.waiting[id] = wait
	c.mu.Unlock()
	c.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	m, ok := <-wait
	if !ok {
		return nil, errors.New("Muse stopped")
	}
	if m.Error != nil {
		return nil, fmt.Errorf("Muse refused %s: %s", method, m.Error.Message)
	}
	return m.Result, nil
}

// read handles everything Muse sends until it stops: answers, session updates and its requests
// (a tool approval is granted: the tools are read-only, writing and the shell are off)
func (c *acpClient) read(r io.Reader) {
	scan := bufio.NewScanner(r)
	scan.Buffer(make([]byte, 64*1024), 32*1024*1024)
	for scan.Scan() {
		var m acpMessage
		if json.Unmarshal(scan.Bytes(), &m) != nil {
			continue
		}
		switch {
		case m.Method == "session/update":
			var p struct {
				Update json.RawMessage `json:"update"`
			}
			if json.Unmarshal(m.Params, &p) == nil {
				c.updates(p.Update)
			}
		case m.Method == "session/request_permission" && m.ID != nil:
			var p struct {
				Options []struct {
					OptionID string `json:"optionId"`
					Kind     string `json:"kind"`
				} `json:"options"`
			}
			_ = json.Unmarshal(m.Params, &p)
			choice := ""
			for _, o := range p.Options {
				if strings.HasPrefix(o.Kind, "allow") && (choice == "" || o.Kind == "allow_once") {
					choice = o.OptionID
				}
			}
			outcome := map[string]any{"outcome": "cancelled"}
			if choice != "" {
				outcome = map[string]any{"outcome": "selected", "optionId": choice}
			}
			c.write(map[string]any{"jsonrpc": "2.0", "id": *m.ID, "result": map[string]any{"outcome": outcome}})
		case m.Method != "" && m.ID != nil: // nothing else is offered to Muse
			c.write(map[string]any{"jsonrpc": "2.0", "id": *m.ID, "error": map[string]any{"code": -32601, "message": "not supported"}})
		case m.ID != nil:
			c.mu.Lock()
			wait := c.waiting[*m.ID]
			delete(c.waiting, *m.ID)
			c.mu.Unlock()
			if wait != nil {
				wait <- m
			}
		}
	}
	c.mu.Lock()
	for id, wait := range c.waiting {
		close(wait)
		delete(c.waiting, id)
	}
	c.mu.Unlock()
}

// runMuse runs one turn on `muse acp` and writes it to stdout as OpenCode events. A turn stopped
// at the step limit exits 0 without an answer, as OpenCode does, so the last checked draft is kept.
func runMuse(muse string, t museTurn) int {
	cmd := exec.Command(muse, t.args...)
	cmd.Stderr = os.Stderr
	stdin, err1 := cmd.StdinPipe()
	stdout, err2 := cmd.StdoutPipe()
	if err := errors.Join(err1, err2); err != nil {
		fmt.Fprintln(os.Stderr, "muse bridge:", err)
		return 2
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "muse bridge: Muse could not start:", err)
		return 2
	}
	defer func() { _ = stdin.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	tr := newMuseTranslator(os.Stdout)
	client := &acpClient{in: stdin, waiting: map[int]chan acpMessage{}, updates: func(u json.RawMessage) { tr.update(u) }}
	done := make(chan struct{})
	go func() { client.read(stdout); close(done) }()
	fail := func(err error) int {
		tr.flush()
		tr.emit(map[string]any{"type": "error", "error": map[string]any{"type": "muse.error", "message": err.Error()}})
		return 1
	}
	if _, err := client.call("initialize", map[string]any{"protocolVersion": 1, "clientCapabilities": map[string]any{"fs": map[string]bool{"readTextFile": false, "writeTextFile": false}, "terminal": false}}); err != nil {
		return fail(err)
	}
	session := t.session
	if session != "" {
		// a loaded session replays its conversation: none of that is this turn's
		tr.mute(true)
		if _, err := client.call("session/load", map[string]any{"sessionId": session, "cwd": t.cwd, "mcpServers": t.mcp}); err != nil {
			session = ""
		}
		tr.mute(false)
	}
	if session == "" {
		result, err := client.call("session/new", map[string]any{"cwd": t.cwd, "mcpServers": t.mcp})
		var r struct {
			SessionID string `json:"sessionId"`
		}
		if err == nil {
			err = json.Unmarshal(result, &r)
		}
		if err != nil || r.SessionID == "" {
			return fail(fmt.Errorf("Muse did not open a session: %v", err))
		}
		session = r.SessionID
		_ = os.WriteFile(t.idFile, []byte(session), 0600)
	}
	tr.session = session
	if _, err := client.call("session/set_mode", map[string]any{"sessionId": session, "modeId": "allowAll"}); err != nil {
		fmt.Fprintln(os.Stderr, "muse bridge:", err)
	}
	// each model step's tokens, from Muse's session log; at the step limit the turn is stopped
	stop := make(chan struct{})
	usage := &museUsage{dir: filepath.Join(t.home, "data", "muse", "sessions"), session: session}
	usage.start()
	var limited sync.Once
	go usage.follow(stop, func(tokens map[string]any) {
		if tr.step(tokens) >= t.steps && t.steps > 0 {
			limited.Do(func() {
				tr.setStepLimit()
				client.write(map[string]any{"jsonrpc": "2.0", "method": "session/cancel", "params": map[string]any{"sessionId": session}})
			})
		}
	})
	result, err := client.call("session/prompt", map[string]any{"sessionId": session, "prompt": []map[string]string{{"type": "text", "text": t.prompt}}})
	usage.drain()
	close(stop)
	tr.flush()
	if tr.stepLimited() {
		return 0
	}
	if err != nil {
		return fail(err)
	}
	var r struct {
		StopReason string `json:"stopReason"`
	}
	_ = json.Unmarshal(result, &r)
	switch r.StopReason {
	case "end_turn", "":
		return 0
	case "max_turn_requests":
		return 0 // as at the step limit
	}
	return fail(fmt.Errorf("the Muse turn ended: %s", strings.ReplaceAll(r.StopReason, "_", " ")))
}

// museUsage follows the session's log for each model call's tokens
type museUsage struct {
	dir, session string
	path         string
	offset       int64
	emit         func(map[string]any)
}

func (u *museUsage) find() string {
	if u.path == "" {
		matches, _ := filepath.Glob(filepath.Join(u.dir, "*", "*", "*", u.session, "session.jsonl"))
		if len(matches) > 0 {
			u.path = matches[0]
		}
	}
	return u.path
}

// start skips what the log already holds: a continued session's earlier turns
func (u *museUsage) start() {
	if path := u.find(); path != "" {
		if info, err := os.Stat(path); err == nil {
			u.offset = info.Size()
		}
	}
}

func (u *museUsage) follow(stop chan struct{}, emit func(map[string]any)) {
	u.emit = emit
	for {
		u.read()
		select {
		case <-stop:
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// drain reads the last calls once the turn has ended
func (u *museUsage) drain() {
	time.Sleep(300 * time.Millisecond)
}

func (u *museUsage) read() {
	path := u.find()
	if path == "" || u.emit == nil {
		return
	}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	if _, err = f.Seek(u.offset, io.SeekStart); err != nil {
		return
	}
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil { // a line still being written is read next time
			return
		}
		u.offset += int64(len(line))
		if tokens := modelCallTokens(line); tokens != nil {
			u.emit(tokens)
		}
	}
}

// modelCallTokens: a finished model call's tokens from a session log line, as OpenCode counts
// them (cache hits apart from fresh input, reasoning apart from output), or nil
func modelCallTokens(line []byte) map[string]any {
	if !strings.Contains(string(line), `"model_completed"`) {
		return nil
	}
	var e struct {
		Payload struct {
			Kind  string `json:"kind"`
			Event struct {
				Kind  string `json:"kind"`
				Usage struct {
					Input      int64 `json:"input_tokens"`
					Output     int64 `json:"output_tokens"`
					CacheRead  int64 `json:"cache_read_tokens"`
					CacheWrite int64 `json:"cache_write_tokens"`
					Reasoning  int64 `json:"reasoning_tokens"`
				} `json:"usage"`
			} `json:"event"`
		} `json:"payload"`
	}
	if json.Unmarshal(line, &e) != nil || e.Payload.Kind != "run" || e.Payload.Event.Kind != "model_completed" {
		return nil
	}
	u := e.Payload.Event.Usage
	return map[string]any{"input": max(0, u.Input-u.CacheRead-u.CacheWrite), "output": max(0, u.Output-u.Reasoning), "reasoning": u.Reasoning, "cache": map[string]any{"read": u.CacheRead, "write": u.CacheWrite}}
}

// museTranslator writes ACP session updates as OpenCode events: text and reasoning per message,
// a tool_use for each finished tool call, a step_finish for each model call.
type museTranslator struct {
	mu       sync.Mutex
	w        io.Writer
	session  string
	muted    bool
	kind, id string // the message being written ("text" or "reasoning") and its id
	text     strings.Builder
	tools    map[string]museTool
	steps    int
	limited  bool
}

type museTool struct {
	name  string
	input json.RawMessage
}

func newMuseTranslator(w io.Writer) *museTranslator {
	return &museTranslator{w: w, tools: map[string]museTool{}}
}

func (t *museTranslator) emit(v map[string]any) {
	if t.session != "" {
		v["sessionID"] = t.session
	}
	b, _ := json.Marshal(v)
	_, _ = t.w.Write(append(b, '\n'))
}

func (t *museTranslator) mute(on bool) { t.mu.Lock(); t.muted = on; t.mu.Unlock() }

func (t *museTranslator) setStepLimit()     { t.mu.Lock(); t.limited = true; t.mu.Unlock() }
func (t *museTranslator) stepLimited() bool { t.mu.Lock(); defer t.mu.Unlock(); return t.limited }

// flush writes the message being written
func (t *museTranslator) flush() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.flushLocked()
}

func (t *museTranslator) flushLocked() {
	text := strings.TrimSpace(t.text.String())
	t.text.Reset()
	if text != "" && t.kind != "" {
		t.emit(map[string]any{"type": t.kind, "part": map[string]any{"type": t.kind, "text": text}})
	}
	t.kind, t.id = "", ""
}

// step writes a finished model call with its tokens and returns how many there have been
func (t *museTranslator) step(tokens map[string]any) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.flushLocked()
	t.steps++
	t.emit(map[string]any{"type": "step_finish", "part": map[string]any{"type": "step-finish", "cost": 0, "tokens": tokens}})
	return t.steps
}

func (t *museTranslator) update(raw json.RawMessage) {
	var u struct {
		Kind string `json:"sessionUpdate"`
		ID   string `json:"messageId"`
		// a message chunk's text; a tool call's content is a list (read in toolDone)
		Content    json.RawMessage `json:"content"`
		ToolCallID string          `json:"toolCallId"`
		Name       string          `json:"name"`
		Title      string          `json:"title"`
		Status     string          `json:"status"`
		RawInput   json.RawMessage `json:"rawInput"`
		RawOutput  json.RawMessage `json:"rawOutput"`
	}
	if json.Unmarshal(raw, &u) != nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.muted {
		return
	}
	switch u.Kind {
	case "agent_message_chunk", "agent_thought_chunk":
		kind := "text"
		if u.Kind == "agent_thought_chunk" {
			kind = "reasoning"
		}
		if kind != t.kind || u.ID != t.id {
			t.flushLocked()
			t.kind, t.id = kind, u.ID
		}
		var chunk struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(u.Content, &chunk)
		t.text.WriteString(chunk.Text)
	case "tool_call":
		t.flushLocked()
		name := u.Name
		if name == "" {
			name, _, _ = strings.Cut(u.Title, " ")
		}
		t.tools[u.ToolCallID] = museTool{name: name, input: u.RawInput}
		if u.Status == "completed" || u.Status == "failed" {
			t.toolDone(u.ToolCallID, u.Status, u.RawOutput, raw)
		}
	case "tool_call_update":
		if u.Status == "completed" || u.Status == "failed" {
			t.flushLocked()
			if len(u.RawInput) > 0 {
				tool := t.tools[u.ToolCallID]
				tool.input = u.RawInput
				t.tools[u.ToolCallID] = tool
			}
			t.toolDone(u.ToolCallID, u.Status, u.RawOutput, raw)
		}
	}
}

// toolDone writes a finished tool call. The output is rawOutput, or else the text content.
func (t *museTranslator) toolDone(id, status string, rawOutput, update json.RawMessage) {
	tool, ok := t.tools[id]
	if !ok {
		return
	}
	delete(t.tools, id)
	output := ""
	if json.Unmarshal(rawOutput, &output) != nil || output == "" {
		var u struct {
			Content []struct {
				Content struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"content"`
		}
		_ = json.Unmarshal(update, &u)
		var parts []string
		for _, c := range u.Content {
			parts = append(parts, c.Content.Text)
		}
		output = strings.Join(parts, "\n")
		if output == "" && len(rawOutput) > 0 {
			output = string(rawOutput)
		}
	}
	name := museToolName(tool.name)
	var input map[string]any
	_ = json.Unmarshal(tool.input, &input)
	if input == nil {
		input = map[string]any{}
	}
	metadata := map[string]any{}
	switch name {
	case "read":
		if p, ok := input["path"].(string); ok {
			input["filePath"] = p
		}
	case "webfetch":
		input["format"] = "markdown"
		if i := strings.LastIndex(output, "\n\nSource: "); i >= 0 {
			metadata["truncated"] = strings.Contains(output[i:], "\nTruncated: true")
			output = output[:i]
		}
	}
	state := map[string]any{"status": "completed", "input": input, "output": output, "metadata": metadata}
	if status != "completed" {
		state = map[string]any{"status": "error", "input": input, "error": output}
	}
	t.emit(map[string]any{"type": "tool_use", "part": map[string]any{"type": "tool", "tool": name, "state": state}})
}

// Muse's tool names as OpenCode's: read_file → read, web_fetch → webfetch, the tracker's tool
// server's tools → tracker_<tool>
func museToolName(tool string) string {
	switch tool {
	case "read_file":
		return "read"
	case "web_fetch":
		return "webfetch"
	case "web_search":
		return "websearch"
	case "list_dir", "list_directory":
		return "list"
	case "search", "grep":
		return "grep"
	case "glob", "find_files":
		return "glob"
	}
	for _, prefix := range []string{"mcp__" + CheckToolName + "__", CheckToolName + "__", CheckToolName + ".", CheckToolName + "/", CheckToolName + ":"} {
		if strings.HasPrefix(tool, prefix) {
			return CheckToolName + "_" + strings.TrimPrefix(tool, prefix)
		}
	}
	return tool
}
