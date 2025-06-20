{ config, pkgs, ... }:
{
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    
    # Source aliases and functions
    initContent = ''
      source ~/.config/zsh/aliases.sh
      source ~/.config/zsh/functions.sh

      git_branch() {
        git branch 2>/dev/null | sed -n 's/^\* //p'
      }
      
      setopt PROMPT_SUBST
      export PS1='%{%F{2}%}%n %{%f%}at %{%F{33}%}%D %* %{%F{2}%}%~ %{%F{yellow}%}$(git_branch)%{%f%}$ '
      
      ZSH_AUTOSUGGEST_USE_ASYNC=true
    '';
  };
}

