# pi-sandbox

macos pi wrapper to handle sandboxing and stuff

## usage

- `pi`: plain pi
- `pi --sandbox`: pi in container
- `pi --sandbox --tools re`: pi in container with tools installed

## sandbox

- needs docker
- image built on first use
- cwd mounted at `/workspace`, `.git` read-only
- pi config and sessions mapped in; `auth.json` stays on the host, so providers logged in there (e.g. anthropic, openai-codex, openrouter) don't work in the sandbox
- read-only root, no caps, no-new-privileges
- `web_search` goes through `bxs serve` on the host; `bx`, `bxs` and the api key stay on the host
- host loopback services keep their addresses: ports of loopback `models.json` providers (e.g. `rec serve`), a loopback `--caido-url` and `--expose` urls are relayed to the host
- those providers' `!command` api keys and headers run on the host at startup, so the resolved key is visible in the container

container is deleted whenever you close pi

## flags

- `--sandbox`: run in container
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
