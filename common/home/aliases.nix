# common/home/aliases.nix
{ config, pkgs, ... }:

# aliases shared across all systems
{
  home.file.".config/zsh/aliases.sh".text = ''
    alias ls='ls --color'
    alias ll='ls -la'
    alias la='ls -A'
    alias l='ls -CF'  
    alias cdc="cd \$(find * -type d -not -path '*/.*' | fzf)"
  '';
}
