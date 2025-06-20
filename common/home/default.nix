{ config, pkgs, lib, ... }:
{
  imports = [
    ./git.nix
    ./nvim.nix
    ./zshrc.nix
    ./aliases.nix
    ./functions.nix
    ./packages.nix
  ];
  
  home.stateVersion = "24.05";

  home.file = {
      ".ssh/config".source = ./dotfiles/ssh/config;    
  }
}
