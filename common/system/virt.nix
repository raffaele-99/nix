{ config, pkgs, lib, ... }:
{
  virtualisation.docker.enable = true;

  # virtualisation configuration (only applies to NixOS)
  config = lib.mkIf (pkgs.stdenv.isLinux) {
    # add any other virtualisation settings here
  };
}
