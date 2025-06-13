{ config, pkgs, ... }:
{
  programs.git = {
    enable = true;
    
    extraConfig = {
      init.defaultBranch = "main";
     
      credential.helper = "!${pkgs.gh}/bin/gh auth git-credential";

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
  '';
  
  home.file.".gitconfig-work".text = ''
    [user]
      name = "luca"
      email = "luca.fuda@tantosec.com"
    [github]
      user = "luca-tanto"
  '';
}
