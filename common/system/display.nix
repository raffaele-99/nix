{ pkgs, config, ... }:

{
  services = {
    xserver = {
      enable = true;
      # Keyboard
      xkb = {
        layout = "au";
        variant = "";
        options = "";
      };
      # i3
      windowManager.i3 = {
        enable = true;
        extraPackages = with pkgs; [
          i3status
        ];
      };
      # Desktop
      desktopManager = {
        xterm.enable = false;
        xfce = {
          enable = true;
          noDesktop = true;
          enableXfwm = false;
        };
        wallpaper = {
          combineScreens = true;
          mode = "fill";
        };
      };
      # Display Manager
      displayManager = {
        lightdm = {
          enable = true;
          # Greeter (AKA login screen)
          greeters = {
            gtk = {
              enable = true;
              extraConfig = ''
                font-name = ${config.luca.font.mainFontName}
              '';
              theme = {
                name = "Arc-Dark";
                package = pkgs.arc-theme;
              };
            };
          };
        };
      };
    };
    displayManager.defaultSession = "xfce+i3";
    # GVFS is apparently to do with trash can
    gvfs.enable = true;
  };

  programs = {
    thunar.enable = true;
    dconf.enable = true;
  };

  environment.variables = {
    GTK_THEME = "Adwaita-dark";
  };
}
