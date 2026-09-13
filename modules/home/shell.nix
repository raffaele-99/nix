{ ... }:
{
  programs.fish = {
    enable = true;
    interactiveShellInit = ''
      fish_add_path "$HOME/go/bin"
      fish_add_path "$HOME/.local/bin"
      set fish_greeting ""
      set fish_prompt_pwd_dir_length 0
      set -gx EDITOR nvim
    '';
    shellAliases = {
      daniel = "nix run --extra-experimental-features 'nix-command flakes' github:stacksparrow4/nix#nvim";
      daniel-unboxed = "nix run --extra-experimental-features 'nix-command flakes' github:stacksparrow4/nix#nvim-unboxed";
    };
  };
}
