package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

const usage = `Usage: luca [options] COMMAND [options] [inputs...]

Commands:
  build, switch     build or activate nix-darwin system
  build-only        build without activating (leaves ./result in checkout)
  update [inputs]   update flakes + build + activate
  update-only [...] update without building or activating
  completions SHELL print completions for bash/zsh/fish

Options:
  --config PATH                read this JSON configuration file
  --no-config                  ignore the installed configuration
  --build-flake PATH           local checkout to build (default: current directory)
  --host NAME                  darwinConfigurations output (inferred if unique)
  --update-flake PATH          checkout to update. repeat for multiple flakes
  --override-input NAME=VALUE  override a build input. repeat as needed
  --dry-run                    just print actions
  --help                       show help (this)

Configuration ($XDG_CONFIG_HOME/luca.json or ~/.config/luca.json):
	build-flake                  path to the build flake for this machine
	host                         machine to use
	update-flakes                path(s) to the update flake(s) for this machine
	override-inputs              idk

Misc:
- passing inputs to the update command will replace the update-flakes list
- Input overrides apply to evaluation/build/activation, never to lock-file updates.
- New files must be added to Git explicitly.
- This tool never stages, commits, pushes, deletes generations, or runs garbage collection.
`

type options struct {
	configPath, buildFlake, host string
	updateFlakes, overrides      []string
	noConfig, dryRun             bool
	command                      string
	inputs                       []string
}

func parseOptions(args []string) (options, error) {
	var o options
	flags := flag.NewFlagSet("luca", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&o.configPath, "config", "", "")
	flags.BoolVar(&o.noConfig, "no-config", false, "")
	flags.StringVar(&o.buildFlake, "build-flake", "", "")
	flags.StringVar(&o.host, "host", "", "")
	flags.BoolVar(&o.dryRun, "dry-run", false, "")
	flags.Func("update-flake", "", func(value string) error {
		o.updateFlakes = append(o.updateFlakes, value)
		return nil
	})
	flags.Func("override-input", "", func(value string) error {
		o.overrides = append(o.overrides, value)
		return nil
	})
	var positional []string
	// flag stops at a positional argument. Resume parsing after each one so
	// global options work on either side of the subcommand, as with sprrw.
	for len(args) > 0 {
		if args[0] == "--" {
			positional = append(positional, args[1:]...)
			break
		}
		if err := flags.Parse(args); err != nil {
			return o, err
		}
		args = flags.Args()
		if len(args) > 0 {
			positional = append(positional, args[0])
			args = args[1:]
		}
	}
	if len(positional) == 0 {
		return o, flag.ErrHelp
	}
	o.command = positional[0]
	if len(positional) > 1 {
		o.inputs = positional[1:]
	}
	if o.configPath != "" && o.noConfig {
		return o, errors.New("--config and --no-config cannot be combined")
	}
	switch o.command {
	case "build", "switch", "build-only":
		if len(o.inputs) != 0 {
			return o, fmt.Errorf("%s does not accept positional arguments", o.command)
		}
	case "update", "update-only":
		for _, input := range o.inputs {
			if !inputName.MatchString(input) {
				return o, fmt.Errorf("invalid input name %q", input)
			}
		}
	case "completions":
		if len(o.inputs) != 1 {
			return o, errors.New("completions requires bash, zsh or fish")
		}
	default:
		return o, fmt.Errorf("unknown command %q", o.command)
	}
	return o, nil
}

type invocation struct {
	dir, program string
	args         []string
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func (c invocation) String() string {
	words := []string{shellQuote(c.program)}
	for _, arg := range c.args {
		words = append(words, shellQuote(arg))
	}
	return "(cd " + shellQuote(c.dir) + " && " + strings.Join(words, " ") + ")"
}

func main() {
	if err := runCLI(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "luca:", err)
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() > 0 {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
}

func runCLI(args []string) error {
	o, err := parseOptions(args)
	if errors.Is(err, flag.ErrHelp) {
		fmt.Print(usage)
		return nil
	}
	if err != nil {
		return err
	}
	if o.command == "completions" {
		return writeCompletions(os.Stdout, o.inputs[0])
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	cfg, err := loadConfig(o, home, cwd, os.Getenv("XDG_CONFIG_HOME"))
	if err != nil {
		return err
	}
	current, err := user.Current()
	if err != nil {
		return err
	}
	uid, err := strconv.Atoi(current.Uid)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a := application{username: current.Username, uid: uid, dryRun: o.dryRun}
	return a.execute(ctx, cfg, o)
}

type application struct {
	username string
	uid      int
	dryRun   bool
}

func (a application) command(ctx context.Context, c invocation, readOnly bool) ([]byte, error) {
	if a.dryRun && !readOnly {
		fmt.Fprintln(os.Stderr, ":: [dry-run]", c.String())
		return nil, nil
	}
	fmt.Fprintln(os.Stderr, "::", c.String())
	cmd := exec.CommandContext(ctx, c.program, c.args...)
	cmd.Dir, cmd.Stdin, cmd.Stderr = c.dir, os.Stdin, os.Stderr
	var output []byte
	var err error
	if readOnly {
		output, err = cmd.Output()
	} else {
		cmd.Stdout = os.Stdout
		err = cmd.Run()
	}
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w", c.program, err)
	}
	return output, nil
}

func nixCommand(dir string, args ...string) invocation {
	return invocation{
		dir: dir, program: "nix",
		args: append([]string{"--extra-experimental-features", "nix-command flakes"}, args...),
	}
}

func (cfg configuration) evaluationFlags() []string {
	if len(cfg.OverrideInputs) == 0 {
		return []string{"--no-update-lock-file"}
	}
	// An override changes the in-memory input graph. --no-update-lock-file
	// would reject that change; --no-write-lock-file keeps it out of Git.
	flags := []string{"--no-write-lock-file"}
	names := make([]string, 0, len(cfg.OverrideInputs))
	for name := range cfg.OverrideInputs {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		flags = append(flags, "--override-input", name, cfg.OverrideInputs[name])
	}
	return flags
}

func (a application) execute(ctx context.Context, cfg configuration, o options) error {
	if runtime.GOOS != "darwin" {
		return errors.New("this helper manages nix-darwin; run it on macOS")
	}
	if a.uid == 0 {
		return errors.New("run luca as your normal macOS user; it requests sudo only for activation")
	}
	updating := o.command == "update" || o.command == "update-only"
	activating := o.command == "build" || o.command == "switch" || o.command == "update"
	var err error
	if o.command != "update-only" {
		cfg.BuildFlake, err = flakeDirectory(cfg.BuildFlake)
		if err != nil {
			return err
		}
	}
	if updating {
		if len(cfg.UpdateFlakes) == 0 {
			return errors.New("no update flakes configured")
		}
		if len(o.inputs) > 0 && len(cfg.UpdateFlakes) != 1 {
			return errors.New("updating named inputs requires a single --update-flake checkout")
		}
		// Validate every checkout before changing any lock file.
		seen := make(map[string]bool)
		var paths []string
		for _, path := range cfg.UpdateFlakes {
			path, err = flakeDirectory(path)
			if err != nil {
				return err
			}
			if !seen[path] {
				paths = append(paths, path)
				seen[path] = true
			}
		}
		cfg.UpdateFlakes = paths
	}
	if o.command != "update-only" {
		if err := a.selectHost(ctx, &cfg); err != nil {
			return err
		}
		if activating {
			if err := a.checkActivation(ctx, cfg); err != nil {
				return err
			}
		}
	}
	if updating {
		for _, path := range cfg.UpdateFlakes {
			// Do not pass local overrides here: updates should write portable
			// upstream pins, not a developer's local checkout, into flake.lock.
			args := append([]string{"flake", "update", "--refresh", "--flake", "."}, o.inputs...)
			if _, err := a.command(ctx, nixCommand(path, args...), false); err != nil {
				return err
			}
		}
		if o.command == "update-only" {
			return nil
		}
		// Input updates may also change the selected host's settings.
		if err := a.checkActivation(ctx, cfg); err != nil {
			return err
		}
	}
	args := []string{"build", ".#darwinConfigurations." + strconv.Quote(cfg.Host) + ".system", "--show-trace"}
	args = append(args, cfg.evaluationFlags()...)
	if _, err := a.command(ctx, nixCommand(cfg.BuildFlake, args...), false); err != nil {
		return err
	}
	if !activating {
		return nil
	}
	// Use the rebuild package exported by the selected flake, not an
	// unrelated registry revision. Both evaluations receive the overrides.
	args = append([]string{"run", ".#darwin-rebuild"}, cfg.evaluationFlags()...)
	args = append(args, "--", "switch", "--flake", ".#"+cfg.Host, "--show-trace")
	args = append(args, cfg.evaluationFlags()...)
	command := nixCommand(cfg.BuildFlake, args...)
	command.program = "/usr/bin/sudo"
	command.args = append([]string{"-H", "--", "nix"}, command.args...)
	_, err = a.command(ctx, command, false)
	return err
}

func (a application) selectHost(ctx context.Context, cfg *configuration) error {
	if cfg.Host != "" {
		return nil
	}
	args := []string{"eval", "--json", ".#darwinConfigurations", "--apply", "builtins.attrNames"}
	args = append(args, cfg.evaluationFlags()...)
	output, err := a.command(ctx, nixCommand(cfg.BuildFlake, args...), true)
	if err != nil {
		return err
	}
	var hosts []string
	if err := json.Unmarshal(output, &hosts); err != nil {
		return fmt.Errorf("read darwinConfigurations: %w", err)
	}
	if len(hosts) != 1 || !hostName.MatchString(hosts[0]) {
		return fmt.Errorf("set --host or the JSON host field; found darwinConfigurations %q", hosts)
	}
	cfg.Host = hosts[0]
	return nil
}

func (a application) checkActivation(ctx context.Context, cfg configuration) error {
	const projection = `c: {
  username = c.shared.username;
  uid = c.shared.uid;
  repoPath = c.home-manager.users.${c.shared.username}.work.repoPath or null;
}`
	args := []string{"eval", "--json", ".#darwinConfigurations." + strconv.Quote(cfg.Host) + ".config", "--apply", projection}
	args = append(args, cfg.evaluationFlags()...)
	output, err := a.command(ctx, nixCommand(cfg.BuildFlake, args...), true)
	if err != nil {
		return err
	}
	var settings struct {
		Username string `json:"username"`
		UID      int    `json:"uid"`
		RepoPath string `json:"repoPath"`
	}
	if err := json.Unmarshal(output, &settings); err != nil {
		return fmt.Errorf("read host settings: %w", err)
	}
	if settings.Username != a.username || settings.UID != a.uid {
		return fmt.Errorf("host %s configures %s (uid %d), but you are %s (uid %d); check shared.username and shared.uid",
			cfg.Host, settings.Username, settings.UID, a.username, a.uid)
	}
	if settings.RepoPath != "" {
		repoPath, err := filepath.EvalSymlinks(settings.RepoPath)
		if err != nil || repoPath != cfg.BuildFlake {
			return fmt.Errorf("work.repoPath is %q, but this checkout is %q; update the private host setting before switching",
				settings.RepoPath, cfg.BuildFlake)
		}
	}
	return nil
}

func writeCompletions(w io.Writer, shell string) error {
	var script string
	switch shell {
	case "fish":
		script = `complete -c luca -f
complete -c luca -n '__fish_use_subcommand' -a 'build switch build-only update update-only completions'
complete -c luca -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'
complete -c luca -l config -r -F -d 'JSON configuration file'
complete -c luca -l no-config -d 'Ignore installed configuration'
complete -c luca -l build-flake -r -a '(__fish_complete_directories)' -d 'Checkout to build'
complete -c luca -l update-flake -r -a '(__fish_complete_directories)' -d 'Checkout to update (repeatable)'
complete -c luca -l host -r -d 'darwinConfigurations output'
complete -c luca -l override-input -r -d 'NAME=VALUE build override (repeatable)'
complete -c luca -l dry-run -d 'Print actions; run read-only checks'
complete -c luca -l help -d 'Show help'
`
	case "bash":
		script = `_luca() {
  local cur="${COMP_WORDS[COMP_CWORD]}" prev="${COMP_WORDS[COMP_CWORD-1]}" entry
  COMPREPLY=()
  case "$prev" in
    --config) while IFS= read -r entry; do COMPREPLY+=("$entry"); done < <(compgen -f -- "$cur"); return ;;
    --build-flake|--update-flake) while IFS= read -r entry; do COMPREPLY+=("$entry"); done < <(compgen -d -- "$cur"); return ;;
    --host|--override-input) return ;;
    completions) COMPREPLY=($(compgen -W 'bash zsh fish' -- "$cur")); return ;;
  esac
  COMPREPLY=($(compgen -W 'build switch build-only update update-only completions --config --no-config --build-flake --host --update-flake --override-input --dry-run --help' -- "$cur"))
}
complete -F _luca luca
`
	case "zsh":
		script = `#compdef luca
_luca() {
  local context state state_descr line
  typeset -A opt_args
  _arguments -C \
    '--config[JSON configuration file]:file:_files' \
    '--no-config[Ignore installed configuration]' \
    '--build-flake[Checkout to build]:directory:_files -/' \
    '--host[darwinConfigurations output]:host:' \
    '*--update-flake[Checkout to update]:directory:_files -/' \
    '*--override-input[Build input override]:NAME=VALUE:' \
    '--dry-run[Print actions; run read-only checks]' \
    '--help[Show help]' \
    '1:command:(build switch build-only update update-only completions)' \
    '*::argument:->args'
  if [[ "$state" == args && "$words[1]" == completions ]]; then
    _values 'shell' bash zsh fish
  fi
}
_luca "$@"
`
	default:
		return fmt.Errorf("unsupported shell %q; use bash, zsh or fish", shell)
	}
	_, err := io.WriteString(w, script)
	return err
}
