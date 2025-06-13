{ config, pkgs, ... }:
{
  # macOS specific system configuration
  system.defaults = {
    dock = {
      show-recents = false;
      minimize-to-application = true;
      tilesize = 48;
    };
    
    finder = {
      AppleShowAllExtensions = true;
      ShowPathbar = true;
      ShowStatusBar = true;
      _FXShowPosixPathInTitle = true;
    };
    
    NSGlobalDomain = {
      AppleKeyboardUIMode = 3;
      ApplePressAndHoldEnabled = false;
      InitialKeyRepeat = 15;
      KeyRepeat = 2;
      NSAutomaticCapitalizationEnabled = false;
      NSAutomaticDashSubstitutionEnabled = false;
      NSAutomaticPeriodSubstitutionEnabled = false;
      NSAutomaticQuoteSubstitutionEnabled = false;
      NSAutomaticSpellingCorrectionEnabled = false;
    };
  };
  
  # Homebrew configuration
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
    };
    
    taps = [
      "homebrew/cask"
    ];
    
    brews = [
      "mas" # Mac App Store CLI
    ];
    
    casks = [
      # Communication
      "slack"
      "discord"
      "microsoft-teams"
      
      "rectangle"
      "obsidian"
      
      "visual-studio-code"
      
    ];
  };
  
  # Enable services
  services.nix-daemon.enable = true;
  
  # System packages
  environment.systemPackages = with pkgs; [
    # macOS specific tools
    m-cli
    dockutil
  ];
  
  programs.zsh.enable = true;
  
  system.stateVersion = 4;
}
