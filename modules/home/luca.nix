{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.luca;
  json = pkgs.formats.json { };
in
{
  options.programs.luca = {
    enable = lib.mkEnableOption "the shared nix-darwin configuration helper" // {
      default = true;
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ../../pkgs/luca { };
      description = "The shared luca command.";
    };
    settings = lib.mkOption {
      type = json.type;
      default = { };
      example = {
        build-flake = "/Users/example/nix";
        host = "personal-macbook";
        update-flakes = [ "/Users/example/nix" ];
        override-inputs = { };
      };
      description = ''
        Host-local settings for luca.json: build-flake, host,
        update-flakes and override-inputs. Leave empty to use the current
        checkout and infer its sole Darwin host. Keep private paths and
        overrides in the consuming private flake.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    xdg.configFile."luca.json" = lib.mkIf (cfg.settings != { }) {
      source = json.generate "luca.json" cfg.settings;
    };
  };
}
