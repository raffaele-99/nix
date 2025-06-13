{ config, pkgs, lib, ... }:
{
  # display configuration (only applies to NixOS)
  config = lib.mkIf (pkgs.stdenv.isLinux) {
    # basic X11 configuration is in host-specific files
    # add any shared display settings here
  };
}
