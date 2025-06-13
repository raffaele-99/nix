{ config, pkgs, ... }:
{
  programs.git = {
    enable = true;
    userName = "raffaele-99";
    userEmail = "raffaele-99@users.noreply.github.com@";
    
    extraConfig = {
      init.defaultBranch = "main";
    };
  };
}

