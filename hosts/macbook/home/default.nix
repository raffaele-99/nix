{ config, pkgs, ... }:
{
  imports = [
    ../../../common/home/default.nix
  ];

  # macOS specific packages
  home.packages = with pkgs; [
    # macOS-specific CLI tools
  ];
}
