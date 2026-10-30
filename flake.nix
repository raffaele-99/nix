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
    pi2 = {
      url = "git+ssh://git@github.com/raffaele-99/pi2.git";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sonic-the-hedgehog = {
      url = "git+https://github.com/take-it-ez-babe/sonic-the-hedgehog";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      nix-darwin,
      home-manager,
      caidoRelease,
      pi2,
      sonic-the-hedgehog,
      ...
    }:
    let
      caidoReleaseInfo = builtins.fromJSON (builtins.readFile caidoRelease);
      caidoOverlay = final: _prev: {
        caido-desktop = final.callPackage ./modules/pkgs/caido/package.nix { releaseInfo = caidoReleaseInfo; };
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
        specialArgs.pi2 = pi2.packages.aarch64-darwin.default;
        modules = [
          self.darwinModules.default
          ./hosts/personal-macbook.nix
        ];
      };

      darwinConfigurations.mac-mini = nix-darwin.lib.darwinSystem {
        specialArgs = {
          pi2 = pi2.packages.aarch64-darwin.default;
          sonic-the-hedgehog = sonic-the-hedgehog.packages.aarch64-darwin.default;
        };
        modules = [
          self.darwinModules.default
          ./hosts/mac-mini.nix
        ];
      };

      packages.aarch64-linux.re-tools = import ./modules/pkgs/pi/toolsets/re {
        pkgs = nixpkgs.legacyPackages.aarch64-linux;
      };

      # Bootstrap with the same nix-darwin revision as the configuration.
      packages.aarch64-darwin.darwin-rebuild = nix-darwin.packages.aarch64-darwin.darwin-rebuild;
      packages.aarch64-darwin.caido-desktop = darwinPkgs.caido-desktop;
      packages.aarch64-darwin.scanhaus = darwinPkgs.callPackage ./modules/pkgs/scanhaus { };
      packages.aarch64-darwin.tart = darwinPkgs.callPackage ./modules/pkgs/tart { };
      packages.aarch64-darwin.bx = nixpkgs.legacyPackages.aarch64-darwin.callPackage ./modules/pkgs/bx { };
      packages.aarch64-darwin.bxs = nixpkgs.legacyPackages.aarch64-darwin.callPackage ./modules/pkgs/bxs { };
      packages.aarch64-darwin.luca = nixpkgs.legacyPackages.aarch64-darwin.callPackage ./modules/pkgs/luca { };
      packages.aarch64-darwin.pi = darwinPkgs.callPackage ./modules/pkgs/pi { nixpkgsRev = nixpkgs.rev; };
      packages.aarch64-darwin.pi2 = pi2.packages.aarch64-darwin.default;
      apps.aarch64-darwin.pi2 = {
        type = "app";
        program = "${self.packages.aarch64-darwin.pi2}/bin/pi2";
        meta.description = "Run Pi with private early-hangup transports";
      };
      apps.aarch64-darwin.luca = {
        type = "app";
        program = "${self.packages.aarch64-darwin.luca}/bin/luca";
        meta.description = "Build, activate and update this Mac's Nix configuration";
      };
      apps.aarch64-darwin.pi = {
        type = "app";
        program = "${self.packages.aarch64-darwin.pi}/bin/pi";
        meta.description = "Run Pi with its tools in a Docker sandbox, or natively with --no-sandbox";
      };
      apps.aarch64-darwin.scanhaus = {
        type = "app";
        program = "${self.packages.aarch64-darwin.scanhaus}/bin/scanhaus";
      };
      apps.aarch64-darwin.tart = {
        type = "app";
        program = "${self.packages.aarch64-darwin.tart}/bin/tart";
      };
      formatter.aarch64-darwin = nixpkgs.legacyPackages.aarch64-darwin.nixfmt;
    };
}
