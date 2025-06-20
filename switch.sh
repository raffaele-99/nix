#!/usr/bin/env bash
set -e

if [[ $(uname) == "Darwin" ]]; then
    echo "Switching macOS configuration..."
    sudo darwin-rebuild switch --flake .#macbook
else
    echo "Switching NixOS configuration..."
    sudo nixos-rebuild switch --flake .#nixos
fi
