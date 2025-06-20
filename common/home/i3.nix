{ config, pkgs, lib, ... }:
{
  # Only configure i3 on Linux systems
  config = lib.mkIf (pkgs.stdenv.isLinux) {
    xsession.windowManager.i3 = {
      enable = true;
      package = pkgs.i3;
      
      config = {
        modifier = "Mod4"; # Use Super key as modifier
        
        fonts = {
          names = [ "JetBrains Mono" ];
          style = "Regular";
          size = 10.0;
        };
        
        # Terminal
        terminal = "ghostty";
        
        # Keybindings
        keybindings = let
          mod = config.xsession.windowManager.i3.config.modifier;
        in {
          # Terminal
          "${mod}+Return" = "exec ${config.xsession.windowManager.i3.config.terminal}";
          
          # Program launcher
          "${mod}+d" = "exec ${pkgs.dmenu}/bin/dmenu_run";
          
          # Window management
          "${mod}+Shift+q" = "kill";
          "${mod}+h" = "focus left";
          "${mod}+j" = "focus down";
          "${mod}+k" = "focus up";
          "${mod}+l" = "focus right";
          "${mod}+Left" = "focus left";
          "${mod}+Down" = "focus down";
          "${mod}+Up" = "focus up";
          "${mod}+Right" = "focus right";
          
          # Move windows
          "${mod}+Shift+h" = "move left";
          "${mod}+Shift+j" = "move down";
          "${mod}+Shift+k" = "move up";
          "${mod}+Shift+l" = "move right";
          "${mod}+Shift+Left" = "move left";
          "${mod}+Shift+Down" = "move down";
          "${mod}+Shift+Up" = "move up";
          "${mod}+Shift+Right" = "move right";
          
          # Split orientation
          "${mod}+b" = "split h";
          "${mod}+v" = "split v";
          
          # Fullscreen
          "${mod}+f" = "fullscreen toggle";
          
          # Container layout
          "${mod}+s" = "layout stacking";
          "${mod}+w" = "layout tabbed";
          "${mod}+e" = "layout toggle split";
          
          # Toggle tiling / floating
          "${mod}+Shift+space" = "floating toggle";
          "${mod}+space" = "focus mode_toggle";
          
          # Focus parent
          "${mod}+a" = "focus parent";
          
          # Workspaces
          "${mod}+1" = "workspace number 1";
          "${mod}+2" = "workspace number 2";
          "${mod}+3" = "workspace number 3";
          "${mod}+4" = "workspace number 4";
          "${mod}+5" = "workspace number 5";
          "${mod}+6" = "workspace number 6";
          "${mod}+7" = "workspace number 7";
          "${mod}+8" = "workspace number 8";
          "${mod}+9" = "workspace number 9";
          "${mod}+0" = "workspace number 10";
          
          # Move to workspace
          "${mod}+Shift+1" = "move container to workspace number 1";
          "${mod}+Shift+2" = "move container to workspace number 2";
          "${mod}+Shift+3" = "move container to workspace number 3";
          "${mod}+Shift+4" = "move container to workspace number 4";
          "${mod}+Shift+5" = "move container to workspace number 5";
          "${mod}+Shift+6" = "move container to workspace number 6";
          "${mod}+Shift+7" = "move container to workspace number 7";
          "${mod}+Shift+8" = "move container to workspace number 8";
          "${mod}+Shift+9" = "move container to workspace number 9";
          "${mod}+Shift+0" = "move container to workspace number 10";
          
          # Reload/restart/exit
          "${mod}+Shift+c" = "reload";
          "${mod}+Shift+r" = "restart";
          "${mod}+Shift+e" = "exec i3-nagbar -t warning -m 'Do you want to exit i3?' -b 'Yes' 'i3-msg exit'";
        };
        
        # Status bar
        bars = [{
          position = "bottom";
          statusCommand = "${pkgs.i3status}/bin/i3status";
        }];
      };
    };
  };
}