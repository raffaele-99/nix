# common/home/aliases.nix
{ config, pkgs, ... }:
{
  home.file.".config/zsh/aliases.sh".text = ''
    alias ls='ls --color'
    alias ll='ls -la'
    alias la='ls -A'
    alias l='ls -CF'  
    alias cdc="cd \$(find * -type d -not -path '*/.*' | fzf)"
  '';
}
