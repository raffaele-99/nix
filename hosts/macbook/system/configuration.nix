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
  
  services.nix-daemon.enable = true;
  
  programs.zsh.enable = true;
  
  system.stateVersion = 4;
}
