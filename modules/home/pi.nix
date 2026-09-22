{
  pkgs,
  sharedNixpkgsRev,
  ...
}:
let
  pi = pkgs.callPackage ../../pkgs/pi-sandbox {
    nixpkgsRev = sharedNixpkgsRev;
    onePasswordCli = pkgs._1password-cli;
    realPi = pkgs.pi-coding-agent;
  };
in
{
  home.packages = [ pi ];

  home.file = {
    ".pi/agent/SYSTEM.md".source = ./pi/SYSTEM.md;
    ".pi/agent/extensions/context-message.ts".source = ./pi/extensions/context-message.ts;
    ".pi/agent/extensions/goal.ts".source = ./pi/extensions/goal.ts;
  };
}
