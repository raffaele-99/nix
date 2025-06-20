{ config, pkgs, lib, ... }:
{
  # Display configuration (only applies to NixOS)
  config = lib.mkIf (pkgs.stdenv.isLinux) {
    # X11 configuration
    services.xserver = {
      enable = true;
      
      # Configure keyboard
      xkb = {
        layout = "au";
        variant = "";
      };

      # Touchpad support
      libinput.enable = true;
      
      # Display manager
      displayManager = {
        lightdm = {
          enable = true;
          greeters.gtk = {
            enable = true;
            theme = {
              name = "Arc-Dark";
              package = pkgs.arc-theme;
            };
            iconTheme = {
              name = "Arc";
              package = pkgs.arc-icon-theme;
            };
          };
        };
        defaultSession = "xfce+i3";
      };
      
      windowManager.i3 = {
        enable = true;
        package = pkgs.i3;
        extraPackages = with pkgs; [
          i3status
        ];
      };
      
      # Desktop environment
      desktopManager.xfce = {
        enable = true;
        noDesktop = true;
        enableXfwm = false;
      };
    };

    programs = {
      thunar.enable = true;
      dconf.enable = true;
    };
  
  };
}