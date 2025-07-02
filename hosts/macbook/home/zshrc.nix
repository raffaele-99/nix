{ config, pkgs, lib, ... }:

# mac-specific zsh config
{
  programs.zsh = {
    # no need to enable or configure nix zsh options, thats already done by home-manager
    
    # https://nix-community.github.io/home-manager/options.xhtml#opt-programs.zsh.initContent
    initContent = lib.mkOrder 1500 ''
      source ~/.config/zsh/mac-aliases.sh

      export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

      export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home
      export ANDROID_HOME=$HOME/Library/Android/sdk && export PATH=$PATH:$ANDROID_HOME/emulator && export PATH=$PATH:$ANDROID_HOME/platform-tools
    '';
  };
}

