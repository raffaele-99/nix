# pi-sandbox

macos pi wrapper to handle sandboxing and stuff

## usage

- `pi`: plain pi
- `pi --sandbox`: pi's tools in container
- `pi --sandbox --tools re`: pi's tools in container with tools installed

## sandbox

- needs docker
- image built on first use
- pi runs on the host with its config, `auth.json` and sessions; none of them enter the container
- the agent's tools run in the container: bash, read, write, edit, grep, find, ls, and `!` commands
- cwd mounted at `/workspace`, `.git` read-only; refuses a cwd that contains `~/.pi/agent`
- read-only root, no caps, no-new-privileges
- the agent can't reach host files: pi's own tools are off (so no tools at all if the sandbox ones fail to load), project `.pi/` files are ignored, and the workspace `AGENTS.md`/`CLAUDE.md` is read through the container
- skills are mounted read-only at their host paths; other extensions run on the host
- `web_fetch` curls from the container and leaves the raw response in its `/tmp`
- `web_search` queries brave on the host (the api key stays there) and saves full output to the container's `/tmp`
- `--expose` urls and a loopback `--caido-url` are relayed to the host

container is deleted whenever you close pi

## flags

- `--sandbox`: run the agent's tools in a container
- `--tools NAME`: add toolset, repeatable
- `--docker-socket`: expose host docker socket
- `--ssh-agent`: relay host ssh agent
- `--op-socket`: restricted 1password cli bridge
- `--caido-url URL`: proxy pi via caido + trust its ca
- `--expose URL`: make a host loopback service reachable at the same url, repeatable
- `--no-cwd`: strip cwd from system prompt

all flags need `--sandbox` except `--caido-url` and `--no-cwd`

## pentesting with caido

- `pi --sandbox --expose http://127.0.0.1:8080`
- then e.g. "enum this host, proxy everything through caido at http://127.0.0.1:8080"
- nothing is proxied unless you ask; through caido, `127.0.0.1` targets are the host's

everything else passes through to pi

## toolsets

> sometimes want agent do things. but, need tools

- extra linux packages for a sandbox session
- built on demand in linux nix store, mounted read-only
- image not rebuilt
- example: `toolsets/re/default.nix`

### add one

- create `toolsets/NAME/default.nix`
- takes `nixpkgsRev`, returns `aarch64-linux` package with `bin` dir
- name matches `[a-zA-Z0-9][a-zA-Z0-9_-]*`
- keep supporting files inside its directory
- register in `toolsets/default.nix`
- `git add -N modules/pkgs/pi/toolsets/NAME`
- `luca build`
- rebuild after any toolset change, definitions copied in at build time
- host-specific: override the package's `sandboxToolsets` argument

### re

- ghidra, jadx, radare2, ipsw
- headless ghidra: `ghidra-analyzeHeadless`
- also exported as `packages.aarch64-linux.re-tools`
