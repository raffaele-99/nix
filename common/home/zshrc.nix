{ config, pkgs, ... }:
{
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    syntaxHighlighting.enable = true;
    
    history = {
      size = 10000;
      save = 10000;
      path = "${config.xdg.dataHome}/zsh/history";
    };
    
    oh-my-zsh = {
      enable = true;
      theme = "robbyrussell";
      plugins = [
        "git"
      ];
    };
    
    shellAliases = {
      ls = "ls --color"
      ll = "ls -l";
      la = "ls -la";
      vimrc = "vim $HOME/.zshrc";
      srcrc = "src $HOME/.zshrc";
      cls = "clear && ls";
      cll = "clear && ls -l";
      cla = "clear && ls -A";
      clsa = "clear && ls -lA";
      rebuild-darwin = "darwin-rebuild switch --flake ~/nix-config#macbook";
      rebuild-nixos = "sudo nixos-rebuild switch --flake ~/nix-config#nixos";
    };
    
  };
}
