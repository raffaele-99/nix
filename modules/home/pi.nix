{
  config,
  lib,
  pkgs,
  sharedNixpkgsRev,
  ...
}:
let
  pi = pkgs.callPackage ../../pkgs/pi-sandbox {
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
      import ../../pkgs/pi-sandbox/toolsets
    );

    home.packages = [ pi ];

    home.file = {
      ".pi/agent/SYSTEM.md".source = ./pi/SYSTEM.md;
      ".pi/agent/extensions/context-message.ts".source = ./pi/extensions/context-message.ts;
      ".pi/agent/extensions/footer.ts".source = ./pi/extensions/footer.ts;
      ".pi/agent/extensions/goal.ts".source = ./pi/extensions/goal.ts;
      ".pi/agent/extensions/openrouter-model.ts".source = ./pi/extensions/openrouter-model.ts;
      ".pi/agent/extensions/save.ts".source = ./pi/extensions/save.ts;
      ".pi/agent/extensions/subagent.ts".source = ./pi/extensions/subagent.ts;
      ".pi/agent/extensions/web-search.ts".source = ./pi/extensions/web-search.ts;
    };
  };
}
