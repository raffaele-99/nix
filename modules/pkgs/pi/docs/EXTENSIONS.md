# EXTENSIONS

There are a lot of extensions in my Pi config, they are all mainly QoL upgrades.

## Threads

Threads are basically a way to "track" an individual session's context. Most harnesses (Claude, Codex, T3) use these extensively for things like subagents and `/side`/`/btw`-style features. Pi does not have anything like this so I have slopped one together.

Each thread is a child session saved alongside the main one (optionally forked from its current history) and shown in an overlay you can cycle through with `Ctrl+/`.

This lets you run side conversations and background workers in parallel without messing up the main session's history.

### `/agents`

Threads are used to enable collaborative subagents that can send messages to each other.

### `/btw`

This will open a new thread using the current session's context so that you can ask a question without derailing the main thread.

### `/goal`

Sets an explicit objective for the current thread.

## Web

Pi doesn't have the ability to access the web by default, two extensions enable this. 

### `web_search`

A tool that lets the model search the web using the Brave Search CLI. Note the tool expects the return format of my [`bx` wrapper](/modules/pkgs/bxs/default.nix). This is purely to minimise token usage.

### `web_fetch`

Downloads a page with `curl`, converts the HTML into markdown, and returns the markdown. This is again to minimise token usage. The raw html is saved to `/tmp` so the agent can retrieve it if it really wants, but most of the time it is happy to use the markdown.

## Models & providers

There are a few provider-specific QoL additions.

### OpenRouter

OpenRouter actually offers many "providers" for a model but I haven't seen any other harness expose this.

If you go to a model page on OpenRouter you will see this, and you'll notice they all differ in price, quant, throughput, and DR policy. So if you are using an OpenRouter key then IMO you need to be able to pick this.

So, you can run `/or-model` to open a specific model picker for OpenRouter that lets you choose the model first, then lets you pick from the list of providers for your chosen model.

### Anthropic

The footer will now show your 7d usage, 5h usage, time till next 7d reset, and how much of your weekly usage you've used in the last few\* hours.

> [!NOTE]
> \* The "few" depends on a number of things but it's easier to just say "few".
> 
> For example if you used 10% in the last 2h, but only 12% in the last 4h, then it will show `10% used in last ~2h`.
> It's meant to be an easy way to see if you are blasting through your usage with the current workload.

### OpenAI

You will get the same footer details as Anthropic as well as support for `/ultrafast` and OpenAI's special server-side compaction.

## Sessions

### Context messages

Lets you insert messages into the conversation without immediately triggering a reply, or pick the exact role (`user`, `system`, `developer`). `Ctrl+Enter` adds the editor contents as user context without starting a turn; `Ctrl+Alt+Enter` opens a composer to choose the role and response policy.

### `/save`

Exports the current session branch to both `.jsonl` and `.html` in `~/.pi/agent/sessions/`, adding `-2`, `-3`, etc. if the name already exists.

## UI

There are a few extensions that just make Pi a little easier to parse visually.

- `bash-collapse.ts`: collapses `bash` calls to a single `$ command` line and exit status until expanded.
- `compact-tools.ts`: collapses `write`, `edit`, `grep`, `find`, and `ls` calls into one-line summaries until expanded.
- `gradient-tools.ts`: groups consecutive tool calls together in the transcript.

## Optional

Off by default, only loaded when you pass the flag:

- `no-cwd.ts` (`--no-cwd`): strips your working directory from the system prompt.
