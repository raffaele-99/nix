# TOOLSETS

Sometimes you will want your `pi` agent to do something non-standard and you know which packages it will need to do it. For example, reverse engineering a binary is pretty much always gonna use the same packages.

Rather than shoving every possible tool I could want into the one sandbox image I have slopped together a "toolset" functionality. Toolsets are opt-in bundles of Linux packages that get mounted into a sandbox session only when you ask for them.

For example the below command will create the default container, but with some reverse engineering packages available too:

```
pi --tools re
```

> [!WARNING]
> In case it isn't obvious this only works with sandboxing enabled. If you pass `--no-sandbox` the agent just uses whatever is on your host.

## How it works

When you pass `--tools`, `sandbox/prepare-tools.sh` builds the requested toolset inside a temporary `nixos/nix` container using the persistent `luca-pi-sandbox-nix` Docker volume.

Everything the toolset needs from that Linux Nix store is then bind-mounted read-only into your sandbox container and added to `PATH`, leaving the base `luca/pi-sandbox` image untouched.

Builds are pinned in the volume so future sessions with the same toolset and nixpkgs revision reuse the cached build instead of rebuilding from scratch.

## Available

### `re`

Reverse engineering tools: `ghidra` (headless via `ghidra-analyzeHeadless`), `jadx`, `radare2`, and `ipsw`.

This is also exported on the flake as `packages.aarch64-linux.re-tools`.

## Adding one

Use `toolsets/re/default.nix` as a reference. A toolset is a directory under `toolsets/<name>/` whose `default.nix` takes `nixpkgsRev` and returns an `aarch64-linux` package with a `bin/` directory. Keep any supporting files inside that directory, and stick to letters, numbers, `-`, and `_` for the name.

Once it's written, register it in `toolsets/default.nix`, track it with git so the flake can see it, and rebuild:

```
git add -N modules/pkgs/pi/toolsets/NAME
luca build
```

> [!NOTE]
> Toolset definitions are copied in at build time, so you need to run `luca build` after making changes to one.

If you want a toolset on only one machine instead of registering it globally, override the package's `sandboxToolsets` argument.

## Files

- `toolsets/default.nix`: maps toolset names to their directories
- `toolsets/re/default.nix`: reverse engineering toolset
- `sandbox/prepare-tools.sh`: builds requested toolsets in the Linux Nix volume and prints the paths to mount
