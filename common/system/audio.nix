{ config, pkgs, lib, ... }:
{
  # audio configuration (only applies to NixOS)
  config = lib.mkIf (pkgs.stdenv.isLinux) {
    # enable sound with pipewire
    sound.enable = true;
    hardware.pulseaudio.enable = false;
    security.rtkit.enable = true;
    services.pipewire = {
      enable = true;
      alsa.enable = true;
      alsa.support32Bit = true;
      pulse.enable = true;
    };
  };
}
