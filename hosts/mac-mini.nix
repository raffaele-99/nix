{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [ ./personal.nix ];

  options.environment.systemPackages = lib.mkOption {
    apply = lib.remove pkgs.brave;
  };

  config = {
    home-manager.users.${config.shared.username} = {
      programs = {
        rectangle.enable = false;

        luca.settings.host = "mac-mini";
      };

      home.file = {
        ".config/aerospace/aerospace.toml".source = ./aerospace.toml;
        ".config/aerospace/ghostty.sh" = {
          source = ./aerospace-ghostty.sh;
          executable = true;
        };
      };
    };
  };
}
