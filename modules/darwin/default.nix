{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.shared;
  homeDirectory = config.users.users.${cfg.username}.home;
in
{
  imports = [ ./packages.nix ];

  options.shared = {
    username = lib.mkOption {
      type = lib.types.str;
      description = "Existing macOS account to configure.";
    };
    uid = lib.mkOption {
      type = lib.types.int;
      default = 501;
      description = "UID of the existing macOS account (id -u).";
    };
    colima.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Start Colima at login to provide a Linux Docker runtime.";
    };
  };

  config = {
    nixpkgs.config.allowUnfree = true;
    nix.settings.experimental-features = [
      "nix-command"
      "flakes"
    ];

    fonts.packages = with pkgs; [
      inter
      nerd-fonts.jetbrains-mono
      nerd-fonts.lilex
    ];

    home-manager = {
      useGlobalPkgs = true;
      useUserPackages = true;
      users.${cfg.username} = {
        home.username = cfg.username;
        home.homeDirectory = homeDirectory;
      };
    };

    users.knownUsers = [ cfg.username ];
    users.users.${cfg.username} = {
      uid = cfg.uid;
      home = lib.mkDefault "/Users/${cfg.username}";
      shell = pkgs.fish;
    };
    programs.fish.enable = true;

    launchd.user.agents.colima = lib.mkIf cfg.colima.enable {
      serviceConfig = {
        ProgramArguments = [
          "${pkgs.colima}/bin/colima"
          "start"
          "--foreground"
        ];
        RunAtLoad = true;
        KeepAlive.SuccessfulExit = true;
        WorkingDirectory = homeDirectory;
        StandardOutPath = "${homeDirectory}/Library/Logs/colima.log";
        StandardErrorPath = "${homeDirectory}/Library/Logs/colima.log";
      };
    };

    security.pam.services.sudo_local.touchIdAuth = true;
    system.primaryUser = cfg.username;
    system.defaults.dock.autohide = lib.mkDefault false;
    # An empty Brewfile removes installed formulae and casks on activation.
    # Keep Homebrew itself and retain application data by avoiding "zap".
    homebrew = {
      enable = true;
      brews = [ ];
      casks = [ ];
      onActivation.cleanup = "uninstall";
      onActivation.autoUpdate = false;
      onActivation.upgrade = false;
      global.autoUpdate = false;
    };
  };
}
