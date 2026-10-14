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
- pi config, auth, sessions mapped in
- read-only root, no caps, no-new-privileges

container is deleted whenever you close pi

## flags

- `--sandbox`: run in container
- `--tools NAME`: add toolset, repeatable
- `--docker-socket`: expose host docker socket
- `--ssh-agent`: relay host ssh agent
- `--op-socket`: restricted 1password cli bridge
- `--caido-url URL`: proxy via caido + trust its ca
- `--no-cwd`: strip cwd from system prompt

all flags need `--sandbox` except `--caido-url` and `--no-cwd`

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
- `git add -N pkgs/pi-sandbox/toolsets/NAME`
- `luca build`
- rebuild after any toolset change, definitions copied in at build time
- host-specific: `programs.pi.sandboxToolsets.NAME = /path`

### re

- ghidra, jadx, radare2, ipsw
- headless ghidra: `ghidra-analyzeHeadless`
- also exported as `packages.aarch64-linux.re-tools`
