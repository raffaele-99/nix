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

  programs.gh = {
    enable = true;
    gitCredentialHelper = {
      enable = false; # this gets configured manually in git.nix
    };
  };
  
  home.stateVersion = "24.05";
}
