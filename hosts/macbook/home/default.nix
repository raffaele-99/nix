{ config, pkgs, ... }:
{
  imports = [
    ../../../common/home/default.nix
    ./aliases.nix
    ./zshrc.nix
    ./functions.nix
  ];

  # macOS specific packages
  home.packages = with pkgs; [
    # macOS-specific CLI tools
    fzf
  ];
}
