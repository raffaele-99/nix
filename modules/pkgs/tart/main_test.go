package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestMountedVolume(t *testing.T) {
	if err := requireMountedVolume("/"); err != nil {
		t.Fatal(err)
	}
	ordinaryDirectory := t.TempDir()
	for _, path := range []string{ordinaryDirectory, filepath.Join(ordinaryDirectory, "missing")} {
		if err := requireMountedVolume(path); err == nil {
			t.Fatalf("accepted an unmounted path: %s", path)
		}
	}
	link := filepath.Join(ordinaryDirectory, "volume-link")
	if err := os.Symlink("/", link); err != nil {
		t.Fatal(err)
	}
	if err := requireMountedVolume(link); err == nil {
		t.Fatal("accepted a symlink as a mount point")
	}
}

func TestStorageDirectories(t *testing.T) {
	home := filepath.Join(t.TempDir(), "tart")
	if err := prepareStorage(home); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"", "cache", "vms", "tmp", "system-tmp"} {
		path := filepath.Join(home, dir)
		info, err := os.Stat(path)
		if err != nil || !info.IsDir() {
			t.Fatalf("missing storage directory %s: %v", path, err)
		}
	}
	marker := filepath.Join(home, "vms", "keep")
	if err := os.WriteFile(marker, []byte("existing VM data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareStorage(home); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "existing VM data" {
		t.Fatal("existing storage was changed")
	}
}

func TestStorageRejectsRedirects(t *testing.T) {
	for _, dir := range []string{"", "cache", "vms", "tmp", "system-tmp"} {
		t.Run(dir, func(t *testing.T) {
			home := filepath.Join(t.TempDir(), "tart")
			if dir != "" {
				if err := os.Mkdir(home, 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.Symlink(t.TempDir(), filepath.Join(home, dir)); err != nil {
				t.Fatal(err)
			}
			if err := prepareStorage(home); err == nil {
				t.Fatal("accepted storage redirected by a symlink")
			}
		})
	}
}

func TestStorageEnvironment(t *testing.T) {
	env := []string{"HOME=/Users/luca", "TART_HOME=/internal", "TMPDIR=/internal/tmp", "TART_HOME=/also-internal", "TART_HOME_EXTRA=keep"}
	home := "/Volumes/External NVME/tart"
	want := []string{"HOME=/Users/luca", "TART_HOME_EXTRA=keep", "TART_HOME=" + home, "TMPDIR=" + home + "/system-tmp/"}
	if got := storageEnvironment(env, home); !reflect.DeepEqual(got, want) {
		t.Fatalf("environment = %q, want %q", got, want)
	}
}

func TestInformationWithoutVolume(t *testing.T) {
	for _, args := range [][]string{nil, {"--version"}, {"run", "--help"}, {"-h"}, {"--generate-completion-script", "fish"}, {"--generate-completion-script=zsh"}} {
		if !informational(args) {
			t.Errorf("requires a volume for informational arguments: %v", args)
		}
	}
	for _, args := range [][]string{{"list"}, {"run", "golden-gate"}, {"clone", "image", "vm"}, {"run", "--", "--help"}} {
		if informational(args) {
			t.Errorf("skips the mount check for arguments: %v", args)
		}
	}
}

func TestExpandLatestCreateShorthand(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want []string
	}{
		{
			name: "latest image",
			args: []string{"create", "latest", "golden-gate"},
			want: []string{"create", "--from-ipsw=latest", "--disk-size=40", "golden-gate"},
		},
		{
			name: "ordinary create",
			args: []string{"create", "golden-gate"},
			want: []string{"create", "golden-gate"},
		},
		{
			name: "incomplete shorthand",
			args: []string{"create", "latest"},
			want: []string{"create", "latest"},
		},
		{
			name: "create with additional options",
			args: []string{"create", "latest", "golden-gate", "--disk-size=80"},
			want: []string{"create", "latest", "golden-gate", "--disk-size=80"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := expandShorthand(test.args); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("expanded arguments = %q, want %q", got, test.want)
			}
		})
	}
}

func TestExecPreservesArgumentsAndStatus(t *testing.T) {
	volume := filepath.Join(t.TempDir(), "unmounted drive")
	script := filepath.Join(t.TempDir(), "upstream tart")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$TART_HOME\" \"$TMPDIR\" \"$@\"\nexit 37\n"), 0700); err != nil {
		t.Fatal(err)
	}
	args := []string{"clone", "image with spaces", "--help", "--", "literal $value"}
	cmd := wrapperProcess(volume, script, args)
	output, err := cmd.CombinedOutput()
	if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 37 {
		t.Fatalf("exit = %v, output = %s", err, output)
	}
	home := filepath.Join(volume, "tart")
	want := strings.Join(append([]string{home, filepath.Join(home, "system-tmp") + "/"}, args...), "\n") + "\n"
	if string(output) != want {
		t.Fatalf("output = %q, want %q", output, want)
	}
	if _, err := os.Stat(volume); !os.IsNotExist(err) {
		t.Fatal("help created storage on an unmounted path")
	}
}

func TestUnmountedDriveNeverRunsTart(t *testing.T) {
	for _, exists := range []bool{false, true} {
		volume := filepath.Join(t.TempDir(), "unmounted drive")
		if exists {
			if err := os.Mkdir(volume, 0700); err != nil {
				t.Fatal(err)
			}
		}
		// Even a usable upstream executable must not run before the mount check.
		cmd := wrapperProcess(volume, "/bin/echo", []string{"list"})
		output, err := cmd.CombinedOutput()
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 1 || !strings.Contains(string(output), "mount the drive") {
			t.Fatalf("unmounted drive: exit = %v, output = %s", err, output)
		}
		if _, err := os.Stat(filepath.Join(volume, "tart")); !os.IsNotExist(err) {
			t.Fatal("created storage on an unmounted path")
		}
	}
}

func wrapperProcess(volume, executable string, args []string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], append([]string{"-test.run=^TestWrapperProcess$", "--"}, args...)...)
	cmd.Env = append(os.Environ(), "TART_WRAPPER_TEST=1", "TART_WRAPPER_VOLUME="+volume, "TART_WRAPPER_EXECUTABLE="+executable, "TART_HOME=/internal", "TMPDIR=/internal/tmp")
	return cmd
}

func TestWrapperProcess(t *testing.T) {
	if os.Getenv("TART_WRAPPER_TEST") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			if err := run(os.Args[i+1:], os.Getenv("TART_WRAPPER_VOLUME"), os.Getenv("TART_WRAPPER_EXECUTABLE")); err != nil {
				fmt.Fprintln(os.Stderr, "tart:", err)
				os.Exit(1)
			}
			os.Exit(0)
		}
	}
	panic("missing wrapper test arguments")
}
