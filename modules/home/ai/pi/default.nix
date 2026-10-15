{
  config,
  lib,
  pkgs,
  sharedNixpkgsRev,
  ...
}:
let
  pi = pkgs.callPackage ../../../pkgs/pi {
    nixpkgsRev = sharedNixpkgsRev;
    onePasswordCli = pkgs._1password-cli;
    realPi = pkgs.pi-coding-agent;
    sandboxToolsets = config.programs.pi.sandboxToolsets;
  };
in
{
  options.programs.pi.sandboxToolsets = lib.mkOption {
    type = lib.types.attrsOf lib.types.path;
    default = { };
    description = ''
      Named Linux toolset expression directories for pi --sandbox --tools NAME.
      Each default.nix accepts nixpkgsRev and returns a package. Toolsets are
      provisioned on demand and mounted read-only without rebuilding the image.
    '';
  };

  config = {
    programs.pi.sandboxToolsets = lib.mapAttrs (_: toolset: lib.mkDefault toolset) (
      import ../../../pkgs/pi/toolsets
    );

    home.packages = [ pi ];

    home.file = {
      ".pi/agent/SYSTEM.md".source = ../../../pkgs/pi/SYSTEM.md;
      ".pi/agent/extensions/bash-collapse.ts".source = ../../../pkgs/pi/extensions/bash-collapse.ts;
      ".pi/agent/extensions/context-message.ts".source = ../../../pkgs/pi/extensions/context-message.ts;
      ".pi/agent/extensions/footer.ts".source = ../../../pkgs/pi/extensions/footer.ts;
      ".pi/agent/extensions/goal.ts".source = ../../../pkgs/pi/extensions/goal.ts;
      ".pi/agent/extensions/openrouter-model.ts".source = ../../../pkgs/pi/extensions/openrouter-model.ts;
      ".pi/agent/extensions/save.ts".source = ../../../pkgs/pi/extensions/save.ts;
      ".pi/agent/extensions/subagent.ts".source = ../../../pkgs/pi/extensions/subagent.ts;
      ".pi/agent/extensions/web-fetch.ts".source = ../../../pkgs/pi/extensions/web-fetch.ts;
      ".pi/agent/extensions/web-search.ts".source = ../../../pkgs/pi/extensions/web-search.ts;
    };
  };
}
