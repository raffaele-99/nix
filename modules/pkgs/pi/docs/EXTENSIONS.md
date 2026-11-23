# EXTENSIONS

Extensions are packaged with `pi` and passed via `-e` by the wrapper instead of being installed into `~/.pi/agent`.

At build time, `default.nix` scans `extensions/` and automatically includes any top-level `.ts` file (or `<dir>/index.ts`) that contains an `export default`. Passing `--no-extensions` (or `-ne`) skips all of them.

> [!NOTE]
> Extensions run on the host, not inside the sandbox container. See [SANDBOX.md](./SANDBOX.md) for how sandboxed tools work.

## Default extensions

### `index.ts`

Bundles the core multi-part extensions from the subdirectories under `extensions/`:

- `providers/`: connectors for OpenAI, Anthropic, OpenRouter, and xAI, plus `/ultrafast` service tier toggling, OpenAI encrypted compaction, and the usage footer (set `PI2_USAGE_TOOL=1` to also expose usage tools).
- `goal/`: thread goal tracking with optional token budgets (`/goal`, plus `get_goal`, `create_goal`, and `update_goal` tools).
- `agents/`: background workers and subagents (`/agents`, `spawn_agent`, `subagent`, `wait_agent`, etc.).
- `btw/`: side thread overlay (`/btw`), with `Ctrl+/` cycling between threads (`threads/`).

### Tools

- `web-search.ts`: adds `web_search`, backed by `bxs` (Brave Search). Runs on the host so the Brave API key never enters the container; when output is truncated, the full JSON is saved to `/tmp` inside the container.
- `web-fetch.ts`: adds `web_fetch`, which curls a URL and converts HTML to markdown (leaving the raw response in `/tmp`). When sandboxed, `curl` runs inside the container via `docker exec`.

### Commands & shortcuts

- `openrouter-model.ts`: adds `/or-model [query]` to fuzzy-search OpenRouter models and pin a specific provider/quantization endpoint for the session.
- `context-message.ts`: adds editor contents to the conversation with an explicit role and response policy (`Ctrl+Enter` appends user context without triggering a turn; `Ctrl+Alt+Enter` opens the composer). Shortcuts can be overridden with `--context-message-key` and `--context-message-composer-key`.
- `save.ts`: adds `/save [name]` to export the current session branch as both `.jsonl` and `.html` into `~/.pi/agent/sessions/` (auto-suffixes to avoid overwriting existing files).

### UI

- `bash-collapse.ts`: collapses unexpanded `bash` tool calls to a single `$ command` line and exit status.
- `compact-tools.ts`: compacts unexpanded `write`, `edit`, `grep`, `find`, and `ls` tool calls and results.
- `gradient-tools.ts`: custom TUI renderer for tool groups and transcript layout.

## Optional extensions

Flag-gated extensions live in `extensions/optional/`. Because that directory has no `index.ts`, auto-discovery ignores it and the wrapper only passes them when their corresponding flag is set (even if `--no-extensions` is used).

- `extensions/optional/caido-openrouter.ts`: enabled by `--caido-url`. Switches OpenRouter's `anthropic/claude-opus-5.5` to the chat completions endpoint so SSE comment heartbeats keep Caido from dropping silent thinking streams.
- `extensions/optional/no-cwd.ts`: enabled by `--no-cwd`. Strips the `cwd` section from model-facing system messages.

## Sandbox extension

`sandbox/sandbox-tools.ts` lives under `sandbox/` rather than `extensions/` because it is part of the sandbox wrapper itself and always gets loaded when running in sandbox mode.

## Files

- `extensions/`: auto-loaded extensions and supporting modules (`features.ts`, `pi-runtime.ts`, `raw-dump.ts`)
- `extensions/optional/`: opt-in extensions loaded by wrapper flags
- `default.nix`: `extensionEntries` discovery logic
