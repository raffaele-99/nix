{
  config,
  lib,
  pkgs,
  sonic-the-hedgehog,
  ...
}:
{
  imports = [ ./personal.nix ];

  options.environment.systemPackages = lib.mkOption {
    apply = lib.remove pkgs.brave;
  };

  config = {
    environment.systemPackages = [
      (pkgs.callPackage ../modules/pkgs/tart { })
      sonic-the-hedgehog
    ];

    security.pam.services.sudo_local.enable = true;

    home-manager.users.${config.shared.username} = {
      programs = {
        rectangle.enable = false;

        luca.settings.host = "mac-mini";
      };
    };
  };
}
