package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const volumePath = "/Volumes/External NVME"

// Nix supplies the upstream executable's absolute path to avoid calling ourselves.
var tartExecutable string

func main() {
	if err := run(os.Args[1:], volumePath, tartExecutable); err != nil {
		fmt.Fprintln(os.Stderr, "tart:", err)
		os.Exit(1)
	}
}

func run(args []string, volume, executable string) error {
	if executable == "" {
		return fmt.Errorf("upstream executable is unset; build this wrapper through Nix")
	}
	args = expandShorthand(args)
	home := filepath.Join(volume, "tart")
	if !informational(args) {
		if err := requireMountedVolume(volume); err != nil {
			return err
		}
		if err := prepareStorage(home); err != nil {
			return err
		}
	}
	// Replacing the process preserves Tart's terminal, signals, and exit status.
	return syscall.Exec(executable, append([]string{executable}, args...), storageEnvironment(os.Environ(), home))
}

func expandShorthand(args []string) []string {
	if len(args) == 3 && args[0] == "create" && args[1] == "latest" {
		return []string{"create", "--from-ipsw=latest", "--disk-size=40", args[2]}
	}
	return args
}

func informational(args []string) bool {
	if len(args) == 0 {
		return true
	}
	for _, arg := range args {
		switch arg {
		case "--":
			return false
		case "-h", "--help", "--version", "--generate-completion-script":
			return true
		}
		if strings.HasPrefix(arg, "--generate-completion-script=") {
			return true
		}
	}
	return false
}

func requireMountedVolume(volume string) error {
	info, err := os.Lstat(volume)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("%s is not mounted; connect and mount the drive before using Tart", volume)
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(volume, &fs); err != nil {
		return fmt.Errorf("check volume %s: %w", volume, err)
	}
	var mount []byte
	for _, c := range fs.Mntonname {
		if c == 0 {
			break
		}
		mount = append(mount, byte(c))
	}
	if string(mount) != filepath.Clean(volume) {
		return fmt.Errorf("%s is not a mounted volume; connect and mount the drive before using Tart", volume)
	}
	return nil
}

func prepareStorage(home string) error {
	// Create only directories below the existing mount; never create /Volumes paths.
	// Keep Foundation's temporary files separate from Tart's own tmp garbage collection.
	for _, dir := range []string{home, filepath.Join(home, "vms"), filepath.Join(home, "cache"), filepath.Join(home, "tmp"), filepath.Join(home, "system-tmp")} {
		if err := os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
			return fmt.Errorf("create storage directory %s: %w", dir, err)
		}
		info, err := os.Lstat(dir)
		if err != nil {
			return fmt.Errorf("check storage directory %s: %w", dir, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("storage directory %s must be a directory, not a file or symlink", dir)
		}
	}
	return nil
}

func storageEnvironment(env []string, home string) []string {
	var result []string
	for _, value := range env {
		if !strings.HasPrefix(value, "TART_HOME=") && !strings.HasPrefix(value, "TMPDIR=") {
			result = append(result, value)
		}
	}
	return append(result, "TART_HOME="+home, "TMPDIR="+filepath.Join(home, "system-tmp")+string(os.PathSeparator))
}
