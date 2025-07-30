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
      
      export PATH="$HOME/go/bin:$PATH"
      export PATH="$HOME/.gem/ruby/3.3.0/bin:$PATH"

      git_branch() {
        local branch=$(git branch 2>/dev/null | sed -n 's/^\* //p')
        if [[ -n "$branch" ]]; then
          echo " $branch"
        fi
      }
      
      setopt PROMPT_SUBST
      export PS1='%{%F{2}%}%n %{%f%}at %{%F{4}%}%~%{%F{yellow}%}$(git_branch)%{%f%} $ '
      
      ZSH_AUTOSUGGEST_USE_ASYNC=true
    '';
  };
}

