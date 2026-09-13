{ config, ... }:
{
  nixpkgs.hostPlatform = "aarch64-darwin";
  shared.username = "luca";
  shared.uid = 501;

  home-manager.users.${config.shared.username}.programs.git.settings = {
    user.name = "raffaele-99";
    user.email = "108209611+raffaele-99@users.noreply.github.com";
    github.user = "raffaele-99";
  };

  system.stateVersion = 6;
}
