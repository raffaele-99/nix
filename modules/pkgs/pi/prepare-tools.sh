#!/bin/sh
# Runs in the Linux Nix provisioning container; stdout is a mount manifest.
set -eu

nixpkgs_rev=$1
toolsets_key=$2
shift 2

# Keep fetch/evaluation caches alongside the persistent Linux Nix store.
export XDG_CACHE_HOME=/nix/var/cache/pi-sandbox
mkdir -p "$XDG_CACHE_HOME"

roots="/nix/var/nix/gcroots/pi-sandbox-tools/$toolsets_key"
mkdir -p "$roots"

for toolset in "$@"; do
  output=$(nix-build "/toolsets/$toolset" \
    --argstr nixpkgsRev "$nixpkgs_rev" \
    --out-link "$roots/$toolset" \
    --max-jobs 1 --cores 1 \
    --option sandbox false)
  test -d "$output/bin" || {
    echo "pi: toolset $toolset has no bin directory" >&2
    exit 1
  }
  printf 'bin\t%s/bin\n' "$output"
  nix-store --query --requisites "$output" | while IFS= read -r path; do
    printf 'mount\t%s\n' "$path"
  done
done
