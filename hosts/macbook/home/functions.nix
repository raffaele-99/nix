# common/home/aliases.nix
{ config, pkgs, ... }:

# aliases shared across all systems
{
  home.file.".config/zsh/mac-functions.sh".text = ''
cdtag() {
    local tag="${1:-Currently Working On}"  # Default to "Currently Working On" if no argument
    local search_path="${2:-/Users/luca}"   # Default search path
    
    # Get the selected directory using fzf
    local selected=$(tags -r -path "$search_path" -q "$tag" | fzf \
        --height 40% \
        --reverse \
        --prompt="Select directory: " \
        --preview 'ls -la {}' \
        --preview-window right:50%:wrap)
    
    # If a directory was selected, cd to it
    if [[ -n "$selected" ]]; then
        cd "$selected"
    fi
}

alias cdwork='cdtag "Currently Working On"'
  '';
}
