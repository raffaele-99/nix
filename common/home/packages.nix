# common/home/packages.nix
{ pkgs, ... }:
{
  # shared packages across both systems
  home.packages = with pkgs; [
    go
    git
    # zsh already enabled in common/home/zshrc.nix
    # nvim already enabled in common/home/nvim.nix
    curl
    wget
    jq
    fzf
    _1password-cli
  ];
}
