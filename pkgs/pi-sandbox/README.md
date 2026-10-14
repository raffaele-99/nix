# Pi sandbox toolsets

The Pi wrapper, toolset catalog, and toolset packages live together in this
directory. Both the installed Home Manager package and `nix run .#pi` use the
catalog in `toolsets/default.nix`.

## Use a toolset

After rebuilding with `luca build`:

```sh
pi --sandbox --tools re
```

Repeat `--tools NAME` to combine toolsets. The launcher provisions Linux
packages on demand, caches them in its Linux Nix store, and mounts their complete
runtime closures read-only into the existing sandbox image. Sessions without
`--tools` do not receive these extra tools. Adding tools does not rebuild the
sandbox image or install the Linux executables on the macOS host.

## Add a toolset

Create `toolsets/data/default.nix`:

```nix
{ nixpkgsRev }:
let
  pkgs = import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${nixpkgsRev}.tar.gz";
  }) {
    system = "aarch64-linux";
  };
in
pkgs.symlinkJoin {
  name = "data-tools";
  paths = with pkgs; [ jq yq-go ripgrep ];
}
```

Register it in `toolsets/default.nix`:

```nix
{
  re = ./re;
  data = ./data;
}
```

From the personal Nix repository, make the new files visible to Git-backed
flakes and rebuild:

```sh
git add --intent-to-add pkgs/pi-sandbox/toolsets/data/default.nix
luca build
pi --sandbox --tools data
```

Each toolset must accept `nixpkgsRev` and return an `aarch64-linux` package with
a `bin` directory. The launcher supplies the pinned nixpkgs revision. Keep
supporting expressions inside the toolset directory because the launcher copies
that directory into its provisioning container. Rebuild the launcher after
changing a toolset definition. A flake package export is optional.

Host-specific toolsets can also be registered with
`programs.pi.sandboxToolsets.<name> = /path/to/toolset;`; these merge with the
catalog defaults.

## RE tools

The `re` toolset contains Ghidra, jadx, radare2, and ipsw and is also exported as
`packages.aarch64-linux.re-tools` by the personal flake.

Use `ghidra-analyzeHeadless` for Ghidra automation. Launching the GUI requires a
display setup. Writable projects and output belong in `/workspace` or `/tmp`.

JADX includes its decompiler and GUI, with optional Quark Engine integration
omitted to avoid its large Python/analytics dependency tree. Its build uses
bounded Gradle/Kotlin memory to support the small Linux VM.
