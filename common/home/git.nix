{ config, pkgs, ... }:
{
  programs.git = {
    enable = true;
    
    extraConfig = {
      init.defaultBranch = "main";
     
      "includeIf \"gitdir:~/source/personal/\"" = {
        path = "~/.gitconfig-personal";
      };
      
      "includeIf \"gitdir:~/source/work/\"" = {
        path = "~/.gitconfig-work";
      };
    };
  };
  
  home.file.".gitconfig-personal".text = ''
    [user]
      name = "luca"
      email = "raffaele-99@users.noreply.github.com"
    [github]
      user = "raffaele-99"
    [url "git@github.com-personal:"]
      insteadOf = "git@github.com:"
  '';
  
  home.file.".gitconfig-work".text = ''
    [user]
      name = "luca"
      email = "luca.fuda@tantosec.com"
    [github]
      user = "luca-tanto"
    [url "git@github.com-work:"]
      insteadOf = "git@github.com:"
  '';
}