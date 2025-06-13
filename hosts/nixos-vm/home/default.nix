{ config, pkgs, ... }:
{
  imports = [
    ../../../common/home/default.nix
  ];
  
  home.packages = with pkgs; [
    burpsuite
    nmap
    freerdp
    openvpn
    docker
  ];
}
