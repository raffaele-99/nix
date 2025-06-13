#!/usr/bin/env bash
set -e

echo "Building NixOS configuration..."

if [[ $(uname) == "Darwin" ]]; then
    echo "Building macOS configuration..."
    darwin-rebuild build --flake .#macbook
else
    echo "Building NixOS configuration..."
    nixos-rebuild build --flake .#nixos
fi
