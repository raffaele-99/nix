{ config, pkgs, lib, ... }:
{
  nix = {
    settings = {
      experimental-features = [ "nix-command" "flakes" ];
    };
  };
}

# common/home/default.nix
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
}
