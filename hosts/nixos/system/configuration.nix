{ config, pkgs, lib, ... }:
{
  imports = [
    ../../../common/system/nix-config.nix
    ../../../common/system/fonts.nix
  ];
  
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;
  
  boot.kernelParams = [ "quiet" "splash" ];
  
  networking = {
    hostName = "pentest-vm";
    networkmanager.enable = true;
    
    firewall = {
      enable = true;
      allowedTCPPorts = [ 22 80 443 8080 8443 ];
      allowedUDPPorts = [ ];
    };
  };
  
  time.timeZone = "Australia/Sydney";
  i18n.defaultLocale = "en_US.UTF-8";
  
  services = {
    openssh = {
      enable = true;
      settings = {
        PasswordAuthentication = false;
        PermitRootLogin = "no";
      };
    };
    
    xserver = {
      enable = true;
      displayManager.gdm.enable = true;
      desktopManager.gnome.enable = true;
      
      xkb = {
        layout = "us";
      };
    };
    
    pipewire = {
      enable = true;
      alsa.enable = true;
      alsa.support32Bit = true;
      pulse.enable = true;
    };
  };
  
  hardware = {
    pulseaudio.enable = false;
  };
  
  security = {
    rtkit.enable = true;
    sudo.wheelNeedsPassword = false; # Change if you want password for sudo
  };
  
  virtualisation = {
    docker = {
      enable = true;
      enableOnBoot = true;
    };
  };
  
  programs = {
    zsh.enable = true;
    
    wireshark = {
      enable = true;
      package = pkgs.wireshark;
    };
    
    gnupg.agent = {
      enable = true;
      enableSSHSupport = true;
    };
  };
  
  users.users.luca = { # Change username
    isNormalUser = true;
    description = "";
    extraGroups = [ "wheel" "networkmanager" "docker" "wireshark" "audio" "video" ];
    shell = pkgs.zsh;
    openssh.authorizedKeys.keys = [
      # Add your SSH public key here
      # "ssh-rsa AAAAB3..."
    ];
  };
  
  environment.systemPackages = with pkgs; [
    vim
    wget
    git
    firefox
    chromium
    gnome.gnome-terminal
    gnome.gnome-tweaks
  ];
  
  system.stateVersion = "24.11";
}
