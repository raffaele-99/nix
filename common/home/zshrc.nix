{ config, pkgs, ... }:
{
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    
    # Source aliases and functions
    initExtra = ''
      # Source custom aliases and functions
      source ${config.home.homeDirectory}/.config/zsh/aliases.sh
      source ${config.home.homeDirectory}/.config/zsh/functions.sh
    '';
  };
}

