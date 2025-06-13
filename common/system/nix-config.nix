{ inputs, pkgs, lib, ... }:
{

  nixpkgs.config.allowUnfree = true;

  nix = {
    settings = {
      experimental-features = [ "nix-command" "flakes" ];
      auto-optimise-store = true;
      trusted-users = [ "@wheel" ];
      nix-path = lib.mkForce "nixpkgs=/etc/nix/inputs/nixpkgs";
    };

    registry = { 
       nixpkgs.flake = inputs.nixpkgs;
       home-manager.flake = inputs.home-manager;
    };

    channel.enable = false;
    
    gc = {
      automatic = true;
      options = "--delete-older-than 7d";
    };
  };

  environment.etc."nix/inputs/nixpkgs".source = "${inputs.nixpkgs}";
}
