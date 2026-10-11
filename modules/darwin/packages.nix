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

      # Native container runtime.
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
    ++ lib.optionals config.shared.colima.enable [
      colima
      docker
      docker-compose
      docker-credential-helpers
    ]
    ++
      lib.optional config.home-manager.users.${config.shared.username}.programs.rectangle.enable
        rectangle;
}
