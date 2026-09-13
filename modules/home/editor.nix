{ pkgs, ... }:
{
  programs.neovim = {
    enable = true;
    defaultEditor = true;
    withRuby = false;
    withPython3 = false;
    plugins = with pkgs.vimPlugins; [
      plenary-nvim
      telescope-nvim
      telescope-fzf-native-nvim
      nvim-web-devicons
      markdown-preview-nvim
    ];
    initLua = builtins.readFile ./nvim.lua;
  };
  home.packages = with pkgs; [
    ripgrep
    fzf
  ];
}
