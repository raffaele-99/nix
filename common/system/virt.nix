{ config, pkgs, lib, ... }:
{
  # virtualisation configuration (only applies to NixOS)
  config = lib.mkIf (pkgs.stdenv.isLinux) {
    virtualisation.docker.enable = true;
    # add any other virtualisation settings here
  };
}
