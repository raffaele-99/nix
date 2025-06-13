# common/home/packages.nix
{ pkgs, ... }:
{
  # Shared packages across both systems
  home.packages = with pkgs; [
    ghostty
    go
    git
    gh    
    curl
    wget
    jq
  ];
}
