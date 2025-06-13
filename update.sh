#!/usr/bin/env bash
set -e

echo "Updating flake inputs..."
nix flake update

echo "Building configuration..."
./build.sh

echo "Update complete!"
