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
        local branch=$(git branch 2>/dev/null | sed -n 's/^\* //p')
        if [[ -n "$branch" ]]; then
          echo " $branch"
        fi
      }
      
      setopt PROMPT_SUBST
      export PS1='%{%F{2}%}%n %{%f%}at %{%F{4}%}%~%{%F{yellow}%}$(git_branch)%{%f%} $ '
      
      ZSH_AUTOSUGGEST_USE_ASYNC=true

      export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home

      export ANDROID_HOME=$HOME/Library/Android/sdk && export PATH=$PATH:$ANDROID_HOME/emulator && export PATH=$PATH:$ANDROID_HOME/platform-tools
    '';
  };
}

