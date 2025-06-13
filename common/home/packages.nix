# common/home/packages.nix
{ pkgs, ... }:
{
  # Shared packages across both systems
  home.packages = with pkgs; [
    # Core tools you specified
    ghostty
    neovim
    go
    
    # Basic utilities
    curl
    wget
    jq
  ];
}
