{
  description = "Minimal multi-machine configuration";

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

  outputs = { self, nixpkgs, nix-darwin, home-manager, ... }:
    let
      username = "luca";
    in
    {
      # macOS configuration
      darwinConfigurations."macbook" = nix-darwin.lib.darwinSystem {
        system = "aarch64-darwin"; # or "x86_64-darwin" for Intel
        modules = [
          ./common/system/nix-config.nix
          ./hosts/macbook/system/configuration.nix
          
          home-manager.darwinModules.home-manager
          {
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.users.${username} =  { pkgs, ... }: { 
              imports = [./hosts/macbook/home/default.nix ];
            };
          }
        ];
      };
      
      # NixOS VM configuration
      nixosConfigurations."nixos" = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          ./hosts/nixos/system/hardware-configuration.nix
          ./hosts/nixos/system/configuration.nix
          
          home-manager.nixosModules.home-manager
          {
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.users.${username} = import ./hosts/nixos/home/default.nix;
          }
        ];
      };
    };
}
