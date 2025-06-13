{ config, pkgs, ... }:
{
  imports = [
    ../../../common/home/default.nix
  ];
  
  # macOS specific home configuration
  home.packages = with pkgs; [
    ghostty
  ];
  
  programs.git.extraConfig = {
    credential.helper = "osxkeychain";
  };
}
