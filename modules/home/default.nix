{ lib, ... }:
{
  imports = [
    ./shell.nix
    ./editor.nix
  ];

  programs.git = {
    enable = true;
    settings.init.defaultBranch = "main";
  };

  # Hosts choose their own Git identity. Shared modules carry no identity.
  home.stateVersion = lib.mkDefault "24.05";
}
