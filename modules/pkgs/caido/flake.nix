{
  description = "Caido Desktop for macOS, tracking the official latest release";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    release = {
      url = "file+https://caido.download/releases/latest";
      flake = false;
    };
  };

  outputs =
    { nixpkgs, release, ... }:
    let
      releaseInfo = builtins.fromJSON (builtins.readFile release);
      overlay = final: _prev: {
        caido-desktop = final.callPackage ./package.nix { inherit releaseInfo; };
      };
    in
    {
      overlays.default = overlay;

      packages = nixpkgs.lib.genAttrs [ "aarch64-darwin" ] (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
            overlays = [ overlay ];
          };
        in
        {
          default = pkgs.caido-desktop;
          caido-desktop = pkgs.caido-desktop;
        }
      );
    };
}
