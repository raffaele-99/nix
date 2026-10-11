{ config, ... }:
{
  imports = [ ./personal.nix ];

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
}
