#!/usr/bin/env bash
set -e

if [[ $(uname) == "Darwin" ]]; then
    echo "Building macOS configuration..."
    darwin-rebuild build --flake .#macbook
else
    echo "Building NixOS configuration..."
    nixos-rebuild build --flake .#nixos
fi
