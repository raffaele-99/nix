{ config, ... }:
{
  imports = [ ./personal.nix ];

  home-manager.users.${config.shared.username}.programs.luca.settings.host = "personal-macbook";
}
