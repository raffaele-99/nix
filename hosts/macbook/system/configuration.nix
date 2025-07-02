{ config, pkgs, ... }:
{
  system.defaults = {
    dock.autohide = false;
  };
  
  ids.gids.nixbld = 350;


  homebrew = {
    enable = true;
    casks = [
      "spotify"
      "slack"
      "discord"
      "arc"
      "google-chrome"
      "docker-desktop"
      "visual-studio-code"
      "ghostty"
      "burp-suite-professional"
      "zulu@17" # added because expo docs said to
    ];
    brews = [
      "glow"
      "watchman" # added because expo docs said to
    ];
    onActivation.cleanup = "zap";
    onActivation.autoUpdate = true;
    onActivation.upgrade = true;
    brewPrefix = "/opt/homebrew/bin";
  };

  programs.zsh = {
    enable = true;
  };

  users.knownUsers = [ "luca" ];
  users.users.luca.uid = 501;
  users.users.luca.home = "/Users/luca";
  
  system.primaryUser = "luca";

  security.pam.services.sudo_local.touchIdAuth = true;
  
  system.stateVersion = 4;

  # Copy each installed app from /nix/store to /Applications/Nix Apps
  system.activationScripts.applications.text = let
    env = pkgs.buildEnv {
      name = "system-applications";
      paths = config.environment.systemPackages;
      pathsToLink = "/Applications";
    };
  in
    pkgs.lib.mkForce ''
      echo "setting up /Applications..." >&2
      rm -rf /Applications/Nix\ Apps
      mkdir -p /Applications/Nix\ Apps
      find ${env}/Applications -maxdepth 1 -type l -exec readlink '{}' + |
      while read -r src; do
        app_name=$(basename "$src")
        echo "copying $src" >&2
        ${pkgs.mkalias}/bin/mkalias "$src" "/Applications/Nix Apps/$app_name"
      done
    '';

}
