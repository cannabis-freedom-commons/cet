package research

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/tidwall/jsonc"
)

const providerKeyEnv = "TRACKER_OPENCODE_PROVIDER_KEY"

// Import only the selected provider, never home agents, plugins, permissions or
// unrelated credentials. Keep it outside the model's evidence workspace.
func (r Runner) copyLocalProvider(home string) (string, error) {
	paths := []string{}
	if r.Config.OpenCodeConfigFile != "" {
		paths = append(paths, r.Config.OpenCodeConfigFile)
	} else {
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			base = filepath.Join(userHome(), ".config")
		}
		dir := filepath.Join(base, "opencode")
		paths = append(paths, filepath.Join(dir, "opencode.json"), filepath.Join(dir, "opencode.jsonc"))
	}
	providerID := strings.SplitN(r.Config.ResearchModel, "/", 2)[0]
	var selected map[string]any
	for _, path := range paths {
		file, err := os.Open(path)
		if os.IsNotExist(err) && r.Config.OpenCodeConfigFile == "" {
			continue
		}
		if err != nil {
			return "", errors.New("OpenCode provider configuration could not be read")
		}
		data, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
		file.Close()
		if err != nil || len(data) > 1024*1024 {
			return "", errors.New("OpenCode provider configuration could not be read or is oversized")
		}
		// Decode only provider blocks: other top-level settings may have any JSON type.
		var blocks map[string]json.RawMessage
		if json.Unmarshal(jsonc.ToJSON(data), &blocks) != nil {
			return "", errors.New("OpenCode provider configuration must be valid JSON or JSONC")
		}
		var providers map[string]json.RawMessage
		if raw, ok := blocks["providers"]; ok && json.Unmarshal(raw, &providers) != nil {
			return "", errors.New("OpenCode provider configuration is invalid")
		}
		if raw, ok := providers[providerID]; ok {
			var provider map[string]any
			if json.Unmarshal(raw, &provider) != nil {
				return "", errors.New("OpenCode provider configuration is invalid")
			}
			selected = mergeProviderConfig(selected, provider)
		}
	}
	if selected == nil {
		return "", nil
	}
	// Only provider settings that OpenCode needs to identify and call the model.
	provider := map[string]any{}
	fields := []string{"name", "env", "package", "canonical", "compatibility", "settings", "headers", "body", "models"}
	for _, name := range fields {
		if value, ok := selected[name]; ok {
			provider[name] = value
		}
	}
	key := ""
	if options, ok := provider["settings"].(map[string]any); ok {
		if value, ok := options["apiKey"].(string); ok {
			key = value
			if strings.HasPrefix(value, "{env:") && strings.HasSuffix(value, "}") {
				key = os.Getenv(strings.TrimSuffix(strings.TrimPrefix(value, "{env:"), "}"))
			}
			if strings.HasPrefix(key, "{file:") {
				return "", errors.New("use a saved OpenCode credential, literal apiKey or {env:NAME} for the selected provider")
			}
			options["apiKey"] = "{env:" + providerKeyEnv + "}"
		}
	}
	// Resolve only credential variables declared by this provider, without inheriting
	// the host environment (which also contains the service's operational secrets).
	if key == "" {
		if names, ok := provider["env"].([]any); ok {
			for _, name := range names {
				if name, ok := name.(string); ok {
					key = os.Getenv(name)
					if key != "" {
						break
					}
				}
			}
		}
	}
	if key != "" {
		options, ok := provider["settings"].(map[string]any)
		if !ok {
			options = map[string]any{}
			provider["settings"] = options
		}
		options["apiKey"] = "{env:" + providerKeyEnv + "}"
		provider["env"] = []string{providerKeyEnv}
	}
	cfg := map[string]any{"$schema": "https://opencode.ai/config.json", "providers": map[string]any{providerID: provider}}
	data, err := json.Marshal(cfg)
	if err != nil {
		return "", errors.New("OpenCode provider configuration could not be encoded")
	}
	dir := filepath.Join(home, "config", "opencode")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	if err = os.WriteFile(filepath.Join(dir, "opencode.json"), data, 0600); err != nil {
		return "", err
	}
	return key, nil
}

// Merge only settings belonging to the selected provider. Later files override
// conflicting values while retaining model definitions and endpoint options.
func mergeProviderConfig(base, override map[string]any) map[string]any {
	if base == nil {
		base = map[string]any{}
	}
	for name, value := range override {
		if nested, ok := value.(map[string]any); ok {
			previous, _ := base[name].(map[string]any)
			value = mergeProviderConfig(previous, nested)
		}
		base[name] = value
	}
	return base
}

func selectedProviderKey(command *exec.Cmd) string {
	for _, value := range command.Env {
		if strings.HasPrefix(value, providerKeyEnv+"=") {
			return strings.TrimPrefix(value, providerKeyEnv+"=")
		}
	}
	return ""
}
