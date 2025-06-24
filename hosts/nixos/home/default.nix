{ config, pkgs, ... }:
{
  imports = [
    ../../../common/home/default.nix
  ];
  
  home.packages = with pkgs; [
    ghostty
    burpsuite
    nmap
    freerdp
    openvpn
  ];
}
