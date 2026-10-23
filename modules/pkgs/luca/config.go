package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	hostName  = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	inputName = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_-]*(/[A-Za-z0-9_][A-Za-z0-9_-]*)*$`)
)

type configuration struct {
	BuildFlake     string            `json:"build-flake"`
	Host           string            `json:"host"`
	UpdateFlakes   []string          `json:"update-flakes"`
	OverrideInputs map[string]string `json:"override-inputs"`
}

func loadConfig(o options, home, cwd, xdgConfigHome string) (configuration, error) {
	var cfg configuration
	if !o.noConfig {
		path := o.configPath
		if path == "" {
			if xdgConfigHome == "" {
				xdgConfigHome = filepath.Join(home, ".config")
			}
			path = filepath.Join(xdgConfigHome, "luca.json")
		}
		path = expandPath(path, home, cwd)
		file, err := os.Open(path)
		if err == nil {
			defer file.Close()
			decoder := json.NewDecoder(file)
			decoder.DisallowUnknownFields()
			var parsed *configuration
			if err := decoder.Decode(&parsed); err != nil {
				return cfg, fmt.Errorf("read %s: %w", path, err)
			}
			if parsed == nil {
				return cfg, fmt.Errorf("%s must contain a JSON object, not null", path)
			}
			cfg = *parsed
			var extra any
			if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
				return cfg, fmt.Errorf("%s must contain one JSON object", path)
			}
		} else if o.configPath != "" || !errors.Is(err, os.ErrNotExist) {
			return cfg, fmt.Errorf("read %s: %w", path, err)
		}
	}
	if o.buildFlake != "" {
		cfg.BuildFlake = o.buildFlake
	}
	if cfg.BuildFlake == "" {
		cfg.BuildFlake = cwd
	}
	cfg.BuildFlake = expandPath(cfg.BuildFlake, home, cwd)
	if o.host != "" {
		cfg.Host = o.host
	}
	if cfg.Host != "" && !hostName.MatchString(cfg.Host) {
		return cfg, fmt.Errorf("invalid host name %q", cfg.Host)
	}
	if len(o.updateFlakes) != 0 {
		cfg.UpdateFlakes = o.updateFlakes
	}
	if cfg.UpdateFlakes == nil {
		cfg.UpdateFlakes = []string{cfg.BuildFlake}
	}
	for i, path := range cfg.UpdateFlakes {
		if path == "" {
			return cfg, errors.New("update-flakes entries cannot be empty")
		}
		cfg.UpdateFlakes[i] = expandPath(path, home, cwd)
	}
	if cfg.OverrideInputs == nil {
		cfg.OverrideInputs = make(map[string]string)
	}
	for _, value := range o.overrides {
		name, target, ok := strings.Cut(value, "=")
		if !ok {
			return cfg, fmt.Errorf("invalid override %q: expected NAME=VALUE", value)
		}
		cfg.OverrideInputs[name] = target
	}
	for name, target := range cfg.OverrideInputs {
		if !inputName.MatchString(name) || strings.TrimSpace(target) == "" {
			return cfg, fmt.Errorf("invalid override %q: expected NAME=VALUE with a nonempty value", name)
		}
	}
	return cfg, nil
}

func expandPath(path, home, cwd string) string {
	if path == "~" {
		path = home
	} else if strings.HasPrefix(path, "~/") {
		path = filepath.Join(home, strings.TrimPrefix(path, "~/"))
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(cwd, path)
	}
	return filepath.Clean(path)
}

func flakeDirectory(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("flake checkout %s: %w", path, err)
	}
	info, err := os.Stat(filepath.Join(resolved, "flake.nix"))
	if err != nil {
		return "", fmt.Errorf("flake checkout %s: %w", path, err)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s/flake.nix is not a file", path)
	}
	return resolved, nil
}
