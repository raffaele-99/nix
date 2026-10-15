{ lib, ... }:
{
  imports = [
    ./shell.nix
    ./docker.nix
    ./editor.nix
    ./glow.nix
    ./rectangle.nix
    ./luca.nix
    ./ai/pi
  ];

  programs.git = {
    enable = true;
    settings.init.defaultBranch = "main";
  };

  # Hosts choose their own Git identity. Shared modules carry no identity.
  home.stateVersion = lib.mkDefault "24.05";
}
