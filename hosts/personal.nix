{
  config,
  pi2,
  ...
}:
{
  nixpkgs.hostPlatform = "aarch64-darwin";
  shared.username = "luca";
  shared.uid = 501;

  environment.systemPackages = [ pi2 ];

  home-manager.users.${config.shared.username} = {
    # ssh-add and other agent clients use this instead of SSH's IdentityAgent.
    home.sessionVariables.SSH_AUTH_SOCK = "${
      config.users.users.${config.shared.username}.home
    }/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock";

    programs = {
      # Personal Macs keep this checkout at ~/nix.
      luca.settings = {
        build-flake = "${config.users.users.${config.shared.username}.home}/nix";
      };

      git.settings = {
        user.name = "raffaele-99";
        user.email = "108209611+raffaele-99@users.noreply.github.com";
        github.user = "raffaele-99";
      };

      ssh = {
        enable = true;
        enableDefaultConfig = false;
        settings."*".IdentityAgent = ''"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"'';
      };
    };

    # Only offer keys from the Dev vault, rather than the default vaults.
    home.file.".config/1Password/ssh/agent.toml".text = ''
      [[ssh-keys]]
      vault = "Dev"
    '';
  };

  system.stateVersion = 6;
}
