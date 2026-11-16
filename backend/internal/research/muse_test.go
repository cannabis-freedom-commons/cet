package research

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/store"
)

// ACP session updates as `muse acp` sends them (from a real run, shortened): a thought, a note,
// a file read, a page fetch, a failed report lookup and the answer.
var museUpdates = []string{
	`{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Checking the "},"messageId":"t1"}`,
	`{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"note first."},"messageId":"t1"}`,
	`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Reading note.txt to find the secret word."},"messageId":"m1"}`,
	`{"sessionUpdate":"tool_call","toolCallId":"c1","title":"read_file note.txt","name":"read_file","kind":"read","status":"in_progress","rawInput":{"path":"note.txt"}}`,
	`{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed","rawOutput":"Read text file ` + "`note.txt`" + `.\n1|The secret word is pineapple."}`,
	`{"sessionUpdate":"tool_call","toolCallId":"c2","title":"web_fetch https://example.com","name":"web_fetch","kind":"fetch","status":"in_progress","rawInput":{"url":"https://example.com/"}}`,
	`{"sessionUpdate":"tool_call_update","toolCallId":"c2","status":"completed","content":[{"type":"content","content":{"type":"text","text":"PAGE\n\nSource: https://example.com/\nStatus: 200 OK\nTruncated: false"}}]}`,
	`{"sessionUpdate":"tool_call","toolCallId":"c3","title":"get_report","name":"mcp__tracker__get_report","status":"in_progress","rawInput":{"slug":"x"}}`,
	`{"sessionUpdate":"tool_call_update","toolCallId":"c3","status":"failed","rawOutput":"no such report"}`,
	`{"sessionUpdate":"usage_update","used":32500,"size":1007997}`,
	`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"{\"word\":"},"messageId":"m2"}`,
	`{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" \"pineapple\"}"},"messageId":"m2"}`,
}

// a model call as Muse's session log records it
const museModelCall = `{"payload_type":"runtime.session","payload":{"kind":"run","run_id":"r","event":{"kind":"model_completed","usage":{"input_tokens":32532,"output_tokens":80,"cached_tokens":32116,"cache_write_tokens":0,"cache_read_tokens":32116,"reasoning_tokens":6},"model":"muse-spark-1.3"}}}`

func TestMuseUpdatesBecomeOpenCodeEvents(t *testing.T) {
	var out bytes.Buffer
	tr := newMuseTranslator(&out)
	tr.session = "01a1e24f-dc18-71f0-a181-d86472636ca4"
	for i, u := range museUpdates {
		tr.update(json.RawMessage(strings.ReplaceAll(u, "PAGE", strings.Repeat("Example Domain text. ", 20))))
		if i == 8 {
			tr.step(modelCallTokens([]byte(museModelCall)))
		}
	}
	tr.flush()
	stream := out.String()
	final, err := FinalText([]byte(stream))
	if err != nil || string(final) != `{"word": "pineapple"}` {
		t.Fatalf("%s %v\n%s", final, err, stream)
	}
	for _, want := range []string{`"type":"reasoning"`, `"text":"Checking the note first."`, `"text":"Reading note.txt to find the secret word."`,
		`"tool":"read"`, `"filePath":"note.txt"`, `"tool":"tracker_get_report"`, `"status":"error"`,
		`"tokens":{"cache":{"read":32116,"write":0},"input":416,"output":74,"reasoning":6}`, `"sessionID":"01a1e24f-dc18-71f0-a181-d86472636ca4"`} {
		if !strings.Contains(stream, want) {
			t.Fatal(want, "\n", stream)
		}
	}
	// a fetched page is evidence, like OpenCode's webfetch
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "research-events.jsonl"), out.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	evidence := ReadToolEvidence(dir)
	if len(evidence) != 1 || evidence[0].URL != "https://example.com/" || strings.Contains(evidence[0].Content, "Source:") {
		t.Fatal(evidence)
	}
	// and the chat shows the notes, the tools with what they read and the step
	log := &memoryRunLog{}
	w := &eventWriter{ctx: context.Background(), store: log, cid: "c", run: "r"}
	if _, err := w.Write(out.Bytes()); err != nil || w.steps != 1 {
		t.Fatal(err, w.steps)
	}
	chat := strings.Join(log.chat, "\n")
	for _, want := range []string{"Reading research context: note.txt", "Opening a public source: https://example.com/", "Reading note.txt to find", "32,532 tokens read"} {
		if !strings.Contains(chat, want) {
			t.Fatal(want, "\n", chat)
		}
	}
	if len(log.usage) != 1 || log.usage[0].CacheRead != 32116 {
		t.Fatal(log.usage)
	}
}

func TestMuseLoadedSessionIsNotReplayed(t *testing.T) {
	var out bytes.Buffer
	tr := newMuseTranslator(&out)
	tr.mute(true)
	tr.update(json.RawMessage(museUpdates[2]))
	tr.mute(false)
	tr.flush()
	if out.Len() != 0 {
		t.Fatal(out.String())
	}
}

func TestMuseSessionLogTokens(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "2026", "11", "16", "s1", "session.jsonl")
	_ = os.MkdirAll(filepath.Dir(log), 0700)
	_ = os.WriteFile(log, []byte(museModelCall+"\n"), 0600)
	u := &museUsage{dir: dir, session: "s1"}
	u.start() // an earlier turn's call is not this turn's
	var got []map[string]any
	u.emit = func(tokens map[string]any) { got = append(got, tokens) }
	f, _ := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0600)
	_, _ = f.WriteString(`{"payload":{"kind":"run","event":{"kind":"started"}}}` + "\n" + museModelCall + "\n" + museModelCall[:40])
	_ = f.Close()
	u.read()
	if len(got) != 1 || got[0]["reasoning"] != int64(6) {
		t.Fatal(got)
	}
}

func TestOpenCodeArgsBecomeMuseTurn(t *testing.T) {
	home, input := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, "config", "muse"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(input, ".opencode", "agents"), 0755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(input, ".opencode", "agents", "enforcement-researcher.md"), []byte("---\nsteps: 24\n---\nYou research enforcement.\n"), 0644)
	_ = os.WriteFile(filepath.Join(input, "opencode.json"), []byte(`{"agent":{"enforcement-probe":{"prompt":"Say OK.","steps":2}},"mcp":{"tracker":{"type":"remote","url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer t"},"enabled":true}}}`), 0644)
	t.Chdir(input)
	call, err := parseOpenCodeArgs([]string{"run", "--pure", "--agent", "enforcement-researcher", "--model", "muse/muse-spark-1.3#xhigh", "--format", "json", "Read request.json."})
	if err != nil {
		t.Fatal(err)
	}
	turn, err := call.museTurn()
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(turn.args, " ")
	for _, want := range []string{"acp --model muse-spark-1.3", "--contributor-mode on", "--disable-shell", "--disable-write"} {
		if !strings.Contains(joined, want) {
			t.Fatal(want, joined)
		}
	}
	if turn.steps != 24 || turn.session != "" || !strings.HasPrefix(turn.prompt, "You research enforcement.") || !strings.HasSuffix(turn.prompt, "Read request.json.") {
		t.Fatal(turn)
	}
	settings, _ := os.ReadFile(filepath.Join(home, "config", "muse", "settings.json"))
	if !strings.Contains(string(settings), `"model_reasoning_efforts":{"muse-spark-1.3":"xhigh"}`) || !strings.Contains(string(settings), `"tracker":{"headers":{"Authorization":"Bearer t"},"type":"streamable-http"`) {
		t.Fatal(string(settings))
	}
	// a correction continues the session the first turn opened, with the feedback alone
	_ = os.WriteFile(turn.idFile, []byte("01a1e24f-dc18"), 0600)
	call, _ = parseOpenCodeArgs(correctionArgs([]string{"run", "--agent", "enforcement-researcher", "--model", "muse/muse-spark-1.3#xhigh", "first"}, "Fix it."))
	again, _ := call.museTurn()
	if !call.continued || again.session != "01a1e24f-dc18" || again.prompt != "Fix it." {
		t.Fatal(again)
	}
	// the probe's instructions come from opencode.json
	call, _ = parseOpenCodeArgs([]string{"run", "--agent", "enforcement-probe", "--model", "muse/muse-spark-1.3", "Reply."})
	probe, _ := call.museTurn()
	if !strings.HasPrefix(probe.prompt, "Say OK.") || probe.steps != 2 {
		t.Fatal(probe)
	}
}

// a RunLog that keeps the chat and the tokens in memory
type memoryRunLog struct {
	chat  []string
	usage []store.RunUsage
}

func (m *memoryRunLog) StartRun(context.Context, string, string, string) error { return nil }
func (m *memoryRunLog) EndRun(context.Context, string, string, string) error   { return nil }
func (m *memoryRunLog) FeedChanged(context.Context)                            {}
func (m *memoryRunLog) AddAIEvent(_ context.Context, _, _, role, kind, text string) error {
	m.chat = append(m.chat, role+"/"+kind+": "+text)
	return nil
}
func (m *memoryRunLog) UpdateRun(_ context.Context, _ string, u store.RunUpdate) error {
	if u.Usage != nil {
		m.usage = append(m.usage, *u.Usage)
	}
	return nil
}
