#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

if [[ "$(uname -s)" != Darwin || "$(id -u)" == 0 ]]; then
  echo 'Run this script as your normal macOS user; it will request sudo when needed.' >&2
  exit 1
fi

configured_user="$(nix --extra-experimental-features 'nix-command flakes' eval \
  --raw '.#darwinConfigurations.personal-macbook.config.shared.username')"
configured_uid="$(nix --extra-experimental-features 'nix-command flakes' eval \
  --json '.#darwinConfigurations.personal-macbook.config.shared.uid')"

if [[ "$configured_user" != "$(id -un)" || "$configured_uid" != "$(id -u)" ]]; then
  echo 'Update shared.username and shared.uid in hosts/personal-macbook.nix to match id -un and id -u.' >&2
  exit 1
fi

bash ./build.sh
sudo -H nix --extra-experimental-features 'nix-command flakes' run \
  .#darwin-rebuild -- switch --flake .#personal-macbook
