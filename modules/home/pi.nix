{ pkgs, ... }:
let
  pi = pkgs.callPackage ../../pkgs/pi-sandbox {
    nixpkgsPath = pkgs.path;
    onePasswordCli = pkgs._1password-cli;
    realPi = pkgs.pi-coding-agent;
  };
in
{
  home.packages = [ pi ];
}
