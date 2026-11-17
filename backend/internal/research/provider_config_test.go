package research

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/burningtree/cannabis-freedom-index-tracker/backend/internal/config"
)

func TestLocalProviderConfigErrorsDoNotExposeContents(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "broken.json")
	os.WriteFile(source, []byte(`{"providers":{"custom":{"settings":{"apiKey":"private-value"}}},broken`), 0600)
	r := Runner{Config: config.Config{ResearchModel: "custom/model", OpenCodeConfigFile: source}}
	_, err := r.copyLocalProvider(filepath.Join(root, "session"))
	if err == nil || strings.Contains(err.Error(), "private-value") {
		t.Fatal("invalid config not rejected privately")
	}
}

func v2ProviderFixture(t *testing.T, path string) {
	t.Helper()
	// Comments, trailing commas and URL/comment-like string contents are deliberate.
	data := `{
		// Native OpenCode 2 config.
		"plugins": ["never-copy-this-plugin"],
		"permissions": [{"action":"*","resource":"*","effect":"allow"}],
		"providers": {
			"custom": {
				"name": "Custom provider",
				"env": ["CUSTOM_TEST_PROVIDER_KEY"],
				"package": "@opencode/ai/providers/openai-compatible",
				"settings": {"baseURL": "https://example.org/v1", "apiKey": "fixture-v2-private-key",},
				"body": {"metadata": {"note": "Keep // and /* inside strings, with \"quotes\"."}},
				"models": {
					"custom-model": {
						"name": "Custom model",
						"limit": {"context": 120000, "output": 8000},
						"variants": [{"id": "max", "body": {"reasoning_effort": "max"}},],
					},
				},
			},
			/* Never import other providers. */
			"unrelated": {"settings": {"apiKey": "unrelated-secret"}},
		},
	}`
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestLocalV2ProviderFromGlobalJSONCIsScopedAndPrivate(t *testing.T) {
	for _, location := range []string{"global json", "global jsonc", "xdg jsonc", "explicit jsonc"} {
		t.Run(location, func(t *testing.T) {
			root := t.TempDir()
			t.Setenv("HOME", root)
			t.Setenv("XDG_CONFIG_HOME", "")
			source := filepath.Join(root, ".config", "opencode", "opencode.jsonc")
			r := Runner{Config: config.Config{ResearchModel: "custom/custom-model#max"}}
			switch location {
			case "global json":
				source = filepath.Join(root, ".config", "opencode", "opencode.json")
			case "xdg jsonc":
				t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
				source = filepath.Join(root, "xdg", "opencode", "opencode.jsonc")
			case "explicit jsonc":
				source = filepath.Join(root, "explicit.jsonc")
				r.Config.OpenCodeConfigFile = source
			}
			v2ProviderFixture(t, source)
			home := filepath.Join(root, "session")
			key, err := r.copyLocalProvider(home)
			if err != nil || key != "fixture-v2-private-key" {
				t.Fatalf("native provider credential not loaded: %v", err)
			}
			target := filepath.Join(home, "config", "opencode", "opencode.json")
			data, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{"fixture-v2-private-key", "unrelated-secret", "never-copy-this-plugin", "permissions"} {
				if strings.Contains(string(data), forbidden) {
					t.Fatal("unrelated settings or credential escaped provider selection")
				}
			}
			var cfg struct {
				Providers map[string]struct {
					Package  string
					Env      []string
					Settings map[string]string
					Body     struct{ Metadata map[string]string }
					Models   map[string]struct {
						Variants []struct {
							ID   string
							Body map[string]string
						}
					}
				}
			}
			if err := json.Unmarshal(data, &cfg); err != nil {
				t.Fatal(err)
			}
			provider := cfg.Providers["custom"]
			if len(cfg.Providers) != 1 || provider.Package != "@opencode/ai/providers/openai-compatible" || provider.Settings["baseURL"] != "https://example.org/v1" || provider.Settings["apiKey"] != "{env:"+providerKeyEnv+"}" || len(provider.Env) != 1 || provider.Env[0] != providerKeyEnv {
				t.Fatal("native provider routing or private credential reference lost")
			}
			variants := provider.Models["custom-model"].Variants
			if len(variants) != 1 || variants[0].ID != "max" || variants[0].Body["reasoning_effort"] != "max" || provider.Body.Metadata["note"] != `Keep // and /* inside strings, with "quotes".` {
				t.Fatal("JSONC parsing changed model variants or string contents")
			}
			info, err := os.Stat(target)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("native provider configuration is not private")
			}
		})
	}
}

func TestLocalProviderConfigMergesGlobalSettingsAndResolvesDeclaredCredential(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("CUSTOM_TEST_PROVIDER_KEY", "declared-private-key")
	path := filepath.Join(root, ".config", "opencode", "opencode.json")
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"providers":{"custom":{"env":["UNSET_TEST_PROVIDER_KEY","CUSTOM_TEST_PROVIDER_KEY"],"settings":{"baseURL":"https://example.org/v1"},"models":{"first":{}}}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+"c", []byte(`{"providers":{"custom":{"settings":{"timeout":30000},"models":{"second":{"variants":[{"id":"max"}]}}}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("UNSET_TEST_PROVIDER_KEY", "")
	home := filepath.Join(root, "session")
	r := Runner{Config: config.Config{ResearchModel: "custom/second#max"}}
	key, err := r.copyLocalProvider(home)
	if err != nil || key != "declared-private-key" {
		t.Fatalf("declared provider credential not resolved: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(home, "config", "opencode", "opencode.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Providers map[string]struct {
			Settings map[string]any
			Models   map[string]any
		}
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		t.Fatal(err)
	}
	p := cfg.Providers["custom"]
	if len(p.Models) != 2 || p.Settings["baseURL"] != "https://example.org/v1" || p.Settings["timeout"] != float64(30000) {
		t.Fatal("global provider settings were replaced instead of merged")
	}
	// An explicit configuration remains authoritative, including a missing file.
	r.Config.OpenCodeConfigFile = filepath.Join(root, "missing.jsonc")
	if _, err := r.copyLocalProvider(home); err == nil {
		t.Fatal("missing explicit configuration silently fell back to global settings")
	}
}

func TestNativeLocalHarnessLoadsCustomProviderFromHomeConfig(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("macOS sandbox")
	}
	binary, err := exec.LookPath("opencode")
	if err != nil {
		t.Skip("OpenCode not installed")
	}
	version, err := localVersion(context.Background(), binary)
	if err != nil {
		t.Fatal(err)
	}
	if !openCode2(version) {
		t.Skip("OpenCode 2 integration test")
	}
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(root, "data"))
	source := filepath.Join(root, "provider.jsonc")
	v2ProviderFixture(t, source)
	input := filepath.Join(root, "input")
	if err = os.Mkdir(input, 0700); err != nil {
		t.Fatal(err)
	}
	r := Runner{Config: config.Config{ResearchRunner: "local", OpenCodeBinary: binary, ResearchModel: "custom/custom-model", OpenCodeConfigFile: source}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd, cleanup, err := r.command(ctx, input, "provider-config-test")
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	cmd.Args = append(cmd.Args[:4], "models", "--standalone")
	data, err := cmd.CombinedOutput()
	if err != nil || !strings.Contains(string(data), "custom/custom-model") {
		t.Fatal("native CLI could not load the custom model", err)
	}
	if selectedProviderKey(cmd) != "fixture-v2-private-key" {
		t.Fatal("selected key missing for diagnostics redaction")
	}
}
