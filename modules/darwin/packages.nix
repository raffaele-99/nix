{
  config,
  lib,
  pkgs,
  ...
}:
{
  environment.systemPackages =
    with pkgs;
    [
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
      vultr-cli
      mullvad

      # Analysis tools.
      caido-desktop

      # Docker-compatible runtime and clients.
      colima
      docker
      docker-compose
      docker-credential-helpers
      container

      # macOS applications.
      _1password-cli
      _1password-gui
      brave
      ghostty-bin
      stats
      syntax-highlight
      grandperspective
    ]
    ++
      lib.optional config.home-manager.users.${config.shared.username}.programs.rectangle.enable
        rectangle;
}
