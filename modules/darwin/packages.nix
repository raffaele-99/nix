{ pkgs, ... }:
{
  environment.systemPackages = with pkgs; [
    # Command-line and development tools.
    curl
    wget
    gh
    uv
    go
    jq
    ripgrep
    fzf
    glow
    ffmpeg
    ansible
    opentofu
    awscli2
    nixfmt
    coreutils
    cmake
    llama-cpp
    pi-coding-agent

    # Analysis tools.
    ghidra
    jadx
    radare2
    ipsw
    nmap
    caido-desktop

    # Docker-compatible runtime and clients.
    colima
    docker
    docker-credential-helpers
    container

    # macOS applications.
    _1password-cli
    rectangle
    obsidian
    google-chrome
    vscode
    ghostty-bin
    claude-code
    codex
    stats
    syntax-highlight
    grandperspective
  ];
}
