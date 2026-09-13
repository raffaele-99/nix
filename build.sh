#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

nix --extra-experimental-features 'nix-command flakes' build \
  '.#darwinConfigurations.personal-macbook.system' --show-trace
