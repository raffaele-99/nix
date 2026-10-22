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
      (callPackage ../../pkgs/bx { })
      (callPackage ../../pkgs/bxs { })
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
      brave
      ghostty-bin
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
