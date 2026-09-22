{
  description = "Personal macOS configuration and reusable Nix modules";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    nix-darwin = {
      url = "github:LnL7/nix-darwin";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    caidoRelease = {
      url = "file+https://caido.download/releases/latest";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nix-darwin,
      home-manager,
      caidoRelease,
      ...
    }:
    let
      caidoReleaseInfo = builtins.fromJSON (builtins.readFile caidoRelease);
      caidoOverlay = final: _prev: {
        caido-desktop = final.callPackage ./pkgs/caido/package.nix { releaseInfo = caidoReleaseInfo; };
      };
      darwinPkgs = import nixpkgs {
        system = "aarch64-darwin";
        config.allowUnfree = true;
        overlays = [ caidoOverlay ];
      };
    in
    {
      homeModules.default = ./modules/home;

      darwinModules.default = {
        imports = [
          home-manager.darwinModules.home-manager
          ./modules/darwin
        ];
        home-manager.sharedModules = [ self.homeModules.default ];
        nixpkgs.overlays = [ caidoOverlay ];
      };

      darwinConfigurations.personal-macbook = nix-darwin.lib.darwinSystem {
        modules = [
          self.darwinModules.default
          ./hosts/personal-macbook.nix
        ];
      };

      # Bootstrap with the same nix-darwin revision as the configuration.
      packages.aarch64-darwin.darwin-rebuild = nix-darwin.packages.aarch64-darwin.darwin-rebuild;
      packages.aarch64-darwin.caido-desktop = darwinPkgs.caido-desktop;
      packages.aarch64-darwin.luca = nixpkgs.legacyPackages.aarch64-darwin.callPackage ./pkgs/luca { };
      apps.aarch64-darwin.luca = {
        type = "app";
        program = "${self.packages.aarch64-darwin.luca}/bin/luca";
        meta.description = "Build, activate and update this Mac's Nix configuration";
      };
      formatter.aarch64-darwin = nixpkgs.legacyPackages.aarch64-darwin.nixfmt;
    };
}
