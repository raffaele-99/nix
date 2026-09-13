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
  };

  outputs =
    {
      self,
      nixpkgs,
      nix-darwin,
      home-manager,
      ...
    }:
    {
      homeModules.default = ./modules/home;

      darwinModules.default = {
        imports = [
          home-manager.darwinModules.home-manager
          ./modules/darwin
        ];
        home-manager.sharedModules = [ self.homeModules.default ];
      };

      darwinConfigurations.personal-macbook = nix-darwin.lib.darwinSystem {
        modules = [
          self.darwinModules.default
          ./hosts/personal-macbook.nix
        ];
      };

      # Bootstrap with the same nix-darwin revision as the configuration.
      packages.aarch64-darwin.darwin-rebuild = nix-darwin.packages.aarch64-darwin.darwin-rebuild;
      formatter.aarch64-darwin = nixpkgs.legacyPackages.aarch64-darwin.nixfmt;
    };
}
