{ config, pkgs, ... }:
{
  programs.neovim = {
    enable = true;
    defaultEditor = true;
    viAlias = true;
    vimAlias = false; # vimgolf
    
    plugins = with pkgs.vimPlugins; [
      {
        plugin = markdown-preview-nvim;
        config = ''
          let g:mkdp_auto_close = 1
          let g:mkdp_refresh_slow = 0
          let g:mkdp_markdown_css = ""
          let g:mkdp_page_title = '「''${name}」'
          let g:mkdp_browser = 'safari'
        '';
      }
    ];
  };
}