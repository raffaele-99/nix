{ lib, ... }:
{
  programs.brave = {
    enable = lib.mkDefault true;
    # Installed system-wide by the shared Darwin package module.
    package = null;
  };
}
