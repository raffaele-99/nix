// bxs is a minimal web search CLI for agents. It runs Brave Search's bx CLI
// and reduces `bx web` output to a compact JSON array of web page results, so
// a single search doesn't flood an agent's context.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

var version = "1.0.0"

const usage = `search the web using the Brave search API

Usage: bxs [OPTIONS] <COMMAND>

Commands:
  search   searches web pages

Options:
  -h, --help      print help
  -V, --version   print version
`

const searchUsage = `web search

Usage: bxs search [OPTIONS] <Q>

Arguments:
  <Q>   search query

Options:
  --count                       number of results
  --timeout                     request timeout in seconds [default: 30]
  --include-site                only include results from these domains (repeatable, exclusive with --exclude-site)
  --exclude-site                exclude results from these domains (repeatable, exclusive with --include-site)
  --operators [<OPERATORS>]     enable search operators in the query (site:, intitle:, etc.) full list at https://search.brave.com/help/operators
  -h, --help                    print help
`

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		fail(usage, "")
	}
	switch a := args[0]; a {
	case "-h", "--help":
		fmt.Print(usage)
	case "help":
		if len(args) > 1 && args[1] == "search" {
			fmt.Print(searchUsage)
		} else {
			fmt.Print(usage)
		}
	case "-V", "--version":
		fmt.Println("bxs", version)
	case "search":
		search(args[1:])
	default:
		if strings.HasPrefix(a, "-") {
			fail(usage, "unknown option %q", a)
		}
		fail(usage, "unknown command %q", a)
	}
}

// fail prints an optional error and the given usage to stderr, then exits 2.
func fail(help, format string, a ...any) {
	if format != "" {
		fmt.Fprintf(os.Stderr, "bxs: "+format+"\n\n", a...)
	}
	fmt.Fprint(os.Stderr, help)
	os.Exit(2)
}

func search(args []string) {
	bxArgs := []string{"web", "--result-filter", "web"}
	var query []string
	seen := map[string]bool{}
	for i := 0; i < len(args); i++ {
		name, val, hasVal := strings.Cut(args[i], "=")
		switch name {
		case "-h", "--help":
			fmt.Print(searchUsage)
			return
		case "--count", "--timeout", "--include-site", "--exclude-site":
			if !hasVal {
				if i+1 >= len(args) {
					fail(searchUsage, "%s requires a value", name)
				}
				i++
				val = args[i]
			}
			bxArgs = append(bxArgs, name, val)
			seen[name] = true
		case "--operators":
			if !hasVal {
				val = "true"
				if i+1 < len(args) && (args[i+1] == "true" || args[i+1] == "false") {
					i++
					val = args[i]
				}
			}
			bxArgs = append(bxArgs, "--operators", val)
		case "--":
			query = append(query, args[i+1:]...)
			i = len(args)
		default:
			if strings.HasPrefix(args[i], "-") {
				fail(searchUsage, "unknown option %q", args[i])
			}
			query = append(query, args[i])
		}
	}
	if seen["--include-site"] && seen["--exclude-site"] {
		fail(searchUsage, "--include-site and --exclude-site cannot be used together")
	}
	if len(query) == 0 {
		fail(searchUsage, "missing search query")
	}
	// Unquoted multi-word queries are joined, so `bxs search foo bar` just works.
	bxArgs = append(bxArgs, "--", strings.Join(query, " "))

	bx, err := exec.LookPath("bx")
	if err != nil {
		fmt.Fprintln(os.Stderr, "bxs: bx not found on PATH")
		os.Exit(127)
	}
	var stdout bytes.Buffer
	cmd := exec.Command(bx, bxArgs...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, &stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		os.Stdout.Write(stdout.Bytes())
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		fmt.Fprintln(os.Stderr, "bxs:", err)
		os.Exit(1)
	}

	out, err := reduceWeb(stdout.Bytes())
	if err != nil {
		// Unexpected shape: fall back to the raw response rather than losing it.
		fmt.Fprintln(os.Stderr, "bxs: could not reduce output, printing raw:", err)
		os.Stdout.Write(stdout.Bytes())
		return
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "bxs:", err)
		os.Exit(1)
	}
}

var tagRE = regexp.MustCompile(`<[^>]+>`)

// clean strips highlight markup (<strong>) and decodes HTML entities.
func clean(s string) string {
	return html.UnescapeString(tagRE.ReplaceAllString(s, ""))
}

type result struct {
	Title       string `json:"title"`
	URL         string `json:"url"`
	Description string `json:"description,omitempty"`
}

func reduceWeb(raw []byte) ([]result, error) {
	var resp struct {
		Web struct{ Results []result } `json:"web"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	out := make([]result, 0, len(resp.Web.Results))
	for _, r := range resp.Web.Results {
		r.Title, r.Description = clean(r.Title), clean(r.Description)
		out = append(out, r)
	}
	return out, nil
}
