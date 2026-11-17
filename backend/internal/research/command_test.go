package research

import (
	"context"
	"encoding/json"
	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/config"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestLocalSandboxProtectsHostFilesAndRunsOpenCode(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS local runner")
	}
	binary, err := exec.LookPath("opencode")
	if err != nil {
		t.Skip("OpenCode not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	version, err := localVersion(ctx, binary)
	if err != nil {
		t.Fatal(err)
	}
	if !openCode2(version) {
		t.Skip("OpenCode 2 integration test")
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "state"))
	input := filepath.Join(root, "input")
	if err = os.Mkdir(input, 0755); err != nil {
		t.Fatal(err)
	}
	r := Runner{Config: config.Config{ResearchRunner: "local", OpenCodeBinary: binary, ResearchModel: "opencode-go/deepseek-v4.1-flash", ResearchKey: "private-test-key"}}
	cmd, cleanup, err := r.command(ctx, input, "test")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	for _, entry := range cmd.Env {
		for _, prefix := range []string{"RESEARCH_API_KEY=", "OPENAI_API_KEY=", "NOSTR_", "GITHUB_", "DATABASE_PATH="} {
			if strings.HasPrefix(entry, prefix) {
				t.Fatal("operational credentials escaped to OpenCode")
			}
		}
	}
	cmd.Args = append(cmd.Args[:4], "--version")
	out, err := cmd.CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != version {
		t.Fatalf("sandbox cannot run OpenCode: %s %v", out, err)
	}
	secret := filepath.Join(root, "host-secret")
	if err = os.WriteFile(secret, []byte("must-not-be-readable"), 0600); err != nil {
		t.Fatal(err)
	}
	denied := exec.CommandContext(ctx, "/usr/bin/sandbox-exec", "-f", cmd.Args[2], "/bin/cat", secret)
	denied.Env = cmd.Env
	out, err = denied.CombinedOutput()
	if err == nil || strings.Contains(string(out), "must-not-be-readable") {
		t.Fatal("host file escaped the sandbox")
	}
}

func TestDockerConfigUsesSelectedModelName(t *testing.T) {
	r := Runner{Config: config.Config{ResearchRunner: "docker", ResearchModel: "opencode-go/another-model#high", ResearchWebSearch: "random"}}
	input := t.TempDir()
	if err := r.configureOpenCode(input, "/tmp/data/opencode/tool-output"); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(input, "opencode.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		WebSearch struct{ Provider string }
		Providers map[string]struct {
			Models map[string]struct {
				Name string `json:"name"`
			} `json:"models"`
		} `json:"providers"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	if name := cfg.Providers["opencode-go"].Models["another-model"].Name; name != "another-model" {
		t.Fatalf("configured model has wrong name: %q", name)
	}
	if cfg.WebSearch.Provider != "random" {
		t.Fatal("configured web search provider was lost")
	}
	message := probeFailure(nil, "other-provider/selected-model#high").Error()
	if !strings.Contains(message, "other-provider/selected-model#high") || strings.Contains(message, "deepseek") {
		t.Fatalf("probe failure must identify selected model: %s", message)
	}
}

func TestCorrectionContinuesSessionWithFeedback(t *testing.T) {
	args := []string{"run", "--standalone", "--agent", "enforcement-researcher", "--format", "json", "Read request.json"}
	got := correctionArgs(args, "fix it")
	want := []string{"run", "--continue", "--standalone", "--agent", "enforcement-researcher", "--format", "json", "fix it"}
	if strings.Join(got, "|") != strings.Join(want, "|") || args[len(args)-1] != "Read request.json" {
		t.Fatal(got)
	}
}
