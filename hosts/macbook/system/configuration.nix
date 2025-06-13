{ config, pkgs, ... }:
{
  system.defaults = {
    dock.autohide = false;
  };
  
  homebrew = {
    enable = true;
    
    casks = [
      "spotify"
      "slack"
      "discord"
      "arc"
      "google-chrome"
      "docker"
      "visual-studio-code"
    ];
  };

    # macOS user accounts
  users.knownUsers = [ "luca" ];
  users.users.luca.uid = 501;
  users.users.luca.home = "/Users/luca";
  users.users.luca.shell = pkgs.zsh;  
  
  system.primaryUser = "luca";

  programs.zsh.enable = true;
  
  system.stateVersion = 4;
}
