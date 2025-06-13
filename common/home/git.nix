# common/home/git.nix
{ config, pkgs, ... }:
{
  programs.git = {
    enable = true;
    
    # We'll set up conditional includes for work/personal
    extraConfig = {
      init.defaultBranch = "main";
      
      # Personal account for ~/source/personal
      "includeIf \"gitdir:~/source/personal/\"" = {
        path = "~/.gitconfig-personal";
      };
      
      # Work account for ~/source/work
      "includeIf \"gitdir:~/source/work/\"" = {
        path = "~/.gitconfig-work";
      };
    };
  };
  
  # Create the conditional git configs
  home.file.".gitconfig-personal".text = ''
    [user]
      name = "luca"
      email = "raffaele-99@users.noreply.github.com"
    [github]
      user = "raffaele-99"
  '';
  
  home.file.".gitconfig-work".text = ''
    [user]
      name = "luca"
      email = "luca.fuda@tantosec.com"
    [github]
      user = "luca-tanto"
  '';
}
