{ config, pkgs, ... }:
{
  imports = [
    ../../../common/home/default.nix
  ];

  home.username = "luca";
  home.homeDirectory = "/Users/luca";
  
  # macOS specific packages
  home.packages = with pkgs; [
    # macOS-specific CLI tools
  ];
}
