{
  config,
  lib,
  pkgs,
  ...
}:
let
  hmPrograms = config.home-manager.users.${config.shared.username}.programs;
in
{
  environment.systemPackages =
    with pkgs;
    [
      # agojadfsbdf
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
      watch

      # haeenaner
      ansible
      opentofu
      awscli2
      vultr-cli
      (callPackage ../pkgs/bx { })
      (callPackage ../pkgs/bxs { })
      (callPackage ../pkgs/pi { nixpkgsRev = config.system.nixpkgsRevision; })

      # xcvbjkepe
      nixfmt
      coreutils
      cmake

      # vcxbiofse
      caido-desktop

      # Native container runtime.
      container

      # nasoignw
      _1password-cli
      _1password-gui
      ghostty-bin
      grandperspective

    ]
    ++ lib.optionals config.shared.colima.enable [
      colima
      docker
      docker-compose
      (callPackage ../pkgs/docker-credential-osxkeychain { })
    ]
    ++ lib.optional hmPrograms.rectangle.enable rectangle;
}
