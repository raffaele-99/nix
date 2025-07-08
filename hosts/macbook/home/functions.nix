# common/home/aliases.nix
{ config, pkgs, ... }:

# aliases shared across all systems
{
  home.file.".config/zsh/mac-functions.sh".text = ''
cdtag() {
    local tag="Currently Working On"
    local search_path="/Users/luca"
    
    local selected=$(cd "$search_path" && tags -r -path . -q "$tag" | while read -r line; do
        realpath "$line"
    done | fzf \
        --height 40% \
        --reverse \
        --prompt="Select directory: " \
        --preview 'ls -la {}' \
        --preview-window right:50%:wrap)
    
    if [[ -n "$selected" ]]; then
        cd "$selected"
    fi
}

alias cdwork='cdtag "Currently Working On"'
  '';
}
