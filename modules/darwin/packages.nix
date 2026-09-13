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
    pi-coding-agent

    # Analysis tools.
    caido-desktop

    # Docker-compatible runtime and clients.
    colima
    docker
    docker-credential-helpers
    container

    # macOS applications.
    _1password-cli
    rectangle
    ghostty-bin
    stats
    syntax-highlight
    grandperspective
  ];
}
