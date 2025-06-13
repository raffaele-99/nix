{ config, pkgs, lib, ... }:
{
  imports = [
    ../../../common/system/nix-config.nix
  ];
  
  # Boot
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;
  
  # Networking
  networking = {
    hostName = "nixos-vm";
    networkmanager.enable = true;
  };
  
  # Time zone
  time.timeZone = "Australia/Sydney";
  
  # Enable X11
  services.xserver = {
    enable = true;
    desktopManager.gnome.enable = true;
  };

  # enable display manager
  services.displayManager.gdm = {
    enable = true;
    wayland = true;
  };
  
  # User
  users.users.luca = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" "docker" ];
    shell = pkgs.zsh;
  };
  
  # Enable Docker
  virtualisation.docker.enable = true;
  
  # System packages
  environment.systemPackages = with pkgs; [
    vim
    git
  ];
  
  programs.zsh.enable = true;
  
  system.stateVersion = "24.05";
}
