# common/home/aliases.nix
{ config, pkgs, ... }:

# aliases shared across all systems
{
  home.file.".config/zsh/mac-aliases.sh".text = ''
    alias nix-rebuild="sudo darwin-rebuild switch --flake '/Users/luca/source/personal/nix/.#macbook'"
  '';
}
