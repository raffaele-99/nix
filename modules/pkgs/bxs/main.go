// wrapper around `bx` to provide minimal web search CLI for agents
package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var version = "1.0.0"

const usage = `search the web using the Brave search API

Usage: bxs [OPTIONS] <COMMAND>

Commands:
  search   searches web pages
  serve    serves search over HTTP

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

const serveUsage = `serve web search over HTTP, so callers can search without access to bx or its API key

Usage: BXS_SERVE_TOKEN=<TOKEN> bxs serve --listen <ADDR>

Requests:
  POST / with "Authorization: Bearer <TOKEN>" and a JSON body:
  {"query": "...", "count": 5, "include_sites": ["..."], "exclude_sites": ["..."], "operators": true}
  responds with the same JSON as 'bxs search'

Options:
  --listen      address to listen on, e.g. 127.0.0.1:8080
  -h, --help    print help
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
		switch {
		case len(args) > 1 && args[1] == "search":
			fmt.Print(searchUsage)
		case len(args) > 1 && args[1] == "serve":
			fmt.Print(serveUsage)
		default:
			fmt.Print(usage)
		}
	case "-V", "--version":
		fmt.Println("bxs", version)
	case "search":
		search(args[1:])
	case "serve":
		serve(args[1:])
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

type searchRequest struct {
	Query        string   `json:"query"`
	Count        int      `json:"count,omitempty"`
	Timeout      int      `json:"-"`
	IncludeSites []string `json:"include_sites,omitempty"`
	ExcludeSites []string `json:"exclude_sites,omitempty"`
	Operators    *bool    `json:"operators,omitempty"`
}

var domainRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]*$`)

func (r searchRequest) bxArgs() ([]string, error) {
	if strings.TrimSpace(r.Query) == "" {
		return nil, errors.New("missing search query")
	}
	if r.Count < 0 || r.Timeout < 0 {
		return nil, errors.New("--count and --timeout must be positive")
	}
	if len(r.IncludeSites) > 0 && len(r.ExcludeSites) > 0 {
		return nil, errors.New("--include-site and --exclude-site cannot be used together")
	}
	args := []string{"web", "--result-filter", "web"}
	if r.Count > 0 {
		args = append(args, "--count", strconv.Itoa(r.Count))
	}
	if r.Timeout > 0 {
		args = append(args, "--timeout", strconv.Itoa(r.Timeout))
	}
	for flag, sites := range map[string][]string{"--include-site": r.IncludeSites, "--exclude-site": r.ExcludeSites} {
		for _, site := range sites {
			if !domainRE.MatchString(site) {
				return nil, fmt.Errorf("%s: invalid domain %q", flag, site)
			}
			args = append(args, flag, site)
		}
	}
	if r.Operators != nil {
		args = append(args, "--operators", strconv.FormatBool(*r.Operators))
	}
	return append(args, "--", r.Query), nil
}

func search(args []string) {
	var req searchRequest
	var query []string
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
			switch name {
			case "--count", "--timeout":
				n, err := strconv.Atoi(val)
				if err != nil {
					fail(searchUsage, "%s requires a number, got %q", name, val)
				}
				if name == "--count" {
					req.Count = n
				} else {
					req.Timeout = n
				}
			case "--include-site":
				req.IncludeSites = append(req.IncludeSites, val)
			case "--exclude-site":
				req.ExcludeSites = append(req.ExcludeSites, val)
			}
		case "--operators":
			enabled := true
			if hasVal || i+1 < len(args) && (args[i+1] == "true" || args[i+1] == "false") {
				if !hasVal {
					i++
					val = args[i]
				}
				var err error
				if enabled, err = strconv.ParseBool(val); err != nil {
					fail(searchUsage, "--operators requires true or false, got %q", val)
				}
			}
			req.Operators = &enabled
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
	// Unquoted multi-word queries are joined, so `bxs search foo bar` just works.
	req.Query = strings.Join(query, " ")

	bxArgs, err := req.bxArgs()
	if err != nil {
		fail(searchUsage, "%v", err)
	}
	out, err := runBx(context.Background(), bxArgs, os.Stderr)
	os.Stdout.Write(out)
	var exitErr *exec.ExitError
	switch {
	case err == nil:
	case errors.As(err, &exitErr):
		os.Exit(exitErr.ExitCode())
	case errors.Is(err, exec.ErrNotFound):
		fmt.Fprintln(os.Stderr, "bxs: bx not found on PATH")
		os.Exit(127)
	default:
		fmt.Fprintln(os.Stderr, "bxs:", err)
		os.Exit(1)
	}
}

func runBx(ctx context.Context, args []string, stderr io.Writer) ([]byte, error) {
	bx, err := exec.LookPath("bx")
	if err != nil {
		return nil, err
	}
	var stdout bytes.Buffer
	cmd := exec.CommandContext(ctx, bx, args...)
	cmd.Stdout, cmd.Stderr = &stdout, stderr
	if err := cmd.Run(); err != nil {
		return stdout.Bytes(), err
	}
	out, err := reduceWeb(stdout.Bytes())
	if err != nil {
		fmt.Fprintln(stderr, "bxs: could not reduce output, printing raw:", err)
		return stdout.Bytes(), nil
	}
	return out, nil
}

func serve(args []string) {
	var addr string
	for i := 0; i < len(args); i++ {
		name, val, hasVal := strings.Cut(args[i], "=")
		switch name {
		case "-h", "--help":
			fmt.Print(serveUsage)
			return
		case "--listen":
			if !hasVal {
				if i+1 >= len(args) {
					fail(serveUsage, "--listen requires an address")
				}
				i++
				val = args[i]
			}
			addr = val
		default:
			fail(serveUsage, "unknown argument %q", args[i])
		}
	}
	if addr == "" {
		fail(serveUsage, "--listen is required")
	}
	token := os.Getenv("BXS_SERVE_TOKEN")
	if token == "" {
		fail(serveUsage, "BXS_SERVE_TOKEN must be set")
	}
	os.Unsetenv("BXS_SERVE_TOKEN")

	log.Fatal(http.ListenAndServe(addr, searchHandler("Bearer "+token)))
}

func searchHandler(authorization string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "use POST", http.StatusMethodNotAllowed)
			return
		}
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(authorization)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		var req searchRequest
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			http.Error(w, "invalid request: "+err.Error(), http.StatusBadRequest)
			return
		}
		args, err := req.bxArgs()
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), time.Minute)
		defer cancel()
		var stderr bytes.Buffer
		out, err := runBx(ctx, args, &stderr)
		if err != nil {
			msg := strings.TrimSpace(stderr.String())
			if msg == "" {
				msg = err.Error()
			}
			http.Error(w, msg, http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(out)
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

func reduceWeb(raw []byte) ([]byte, error) {
	var resp struct {
		Web struct{ Results []result } `json:"web"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, err
	}
	results := make([]result, 0, len(resp.Web.Results))
	for _, r := range resp.Web.Results {
		r.Title, r.Description = clean(r.Title), clean(r.Description)
		results = append(results, r)
	}
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(results); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
