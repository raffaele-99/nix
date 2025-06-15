# common/home/packages.nix
{ pkgs, ... }:
{
  # Shared packages across both systems
  home.packages = with pkgs; [
    # ghostty broken on mac
    go
    git
    # gh already enabled in common/home/default.nix
    # zsh already enabled in common/home/zshrc.nix
    # nvim already enabled in common/home/nvim.nix
    curl
    wget
    jq
    fzf
    _1password-cli
  ];
}
