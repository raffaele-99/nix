{ config, pkgs, ... }:
{
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    
    # Source aliases and functions
    initContent = ''
      # Source custom aliases and functions
      source ~/.config/zsh/aliases.sh
      source ~/.config/zsh/functions.sh
      export PS1="%{%F{2}%}%n %{%f%}at %{%F{33}%}%D %* %{%F{2}%}%~ %{%f%}$ "
    '';
  };
}

