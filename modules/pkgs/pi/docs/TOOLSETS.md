# TOOLSETS

Toolsets let you pull extra Linux packages into a sandbox session on demand without rebuilding the base `luca/pi-sandbox` image.

Pass one or more with `--tools`:

```
pi --tools re
```

The flag is repeatable if you want multiple toolsets in the same session. Toolsets only work in sandbox mode (passing `--tools` with `--no-sandbox` will error).

## Available

### `re`

Reverse engineering tools:

- `ghidra` (headless via `ghidra-analyzeHeadless`)
- `jadx`
- `radare2`
- `ipsw`

This is also exported directly from the flake as `packages.aarch64-linux.re-tools`.

## How it works

When you pass `--tools`, the wrapper runs `sandbox/prepare-tools.sh` inside a temporary `nixos/nix` container against the persistent `luca-pi-sandbox-nix` volume.

Each requested toolset is built in that Linux Nix store and pinned with a GC root under `/nix/var/nix/gcroots/pi-sandbox-tools/`. The script outputs a manifest of the full Nix store closure and `bin/` paths, which the wrapper bind-mounts read-only into the sandbox container and prepends to `PATH`.

Because the Nix store lives in the persistent volume, subsequent runs with the same toolset and `nixpkgsRev` reuse the cached build instead of rebuilding.

## Adding a toolset

1. Create `toolsets/NAME/default.nix`. The name must match `[a-zA-Z0-9][a-zA-Z0-9_-]*`, and any supporting files should live inside `toolsets/NAME/`.
2. The expression should accept `nixpkgsRev` and return an `aarch64-linux` derivation with a `bin/` directory (see `toolsets/re/default.nix` for an example).
3. Register it in `toolsets/default.nix`.
4. Track the new files with git so Nix flakes can see them, then rebuild:

```
git add -N modules/pkgs/pi/toolsets/NAME
luca build
```

> [!NOTE]
> Toolset definitions are copied into the Nix store at build time, so run `luca build` after any change to a toolset.

If you want host-specific toolsets without registering them globally, override the package's `sandboxToolsets` argument.

## Files

- `toolsets/default.nix`: registry mapping toolset names to their directories
- `toolsets/re/default.nix`: reverse engineering toolset definition
- `sandbox/prepare-tools.sh`: builds requested toolsets in the Linux Nix volume and outputs the mount manifest
