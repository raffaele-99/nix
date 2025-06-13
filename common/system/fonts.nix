{ pkgs, config, lib, ... }:

let cfg = config.luca.font; in {
  options.luca.font = {
    mainFont = lib.mkOption {
      type = lib.types.package;
    };

    mainFontName = lib.mkOption {
      type = lib.types.str;
    };

    mainFontMonoName = lib.mkOption {
      type = lib.types.str;
    };
  };

  config = {
    sprrw.font = {
      mainFont = pkgs.nerd-fonts.iosevka-term;
      mainFontName = "Iosevka Term Nerd Font";
      mainFontMonoName = "Iosevka Term Nerd Font Mono";
    };

    fonts.packages = [
      cfg.mainFont
    ];
  };
}
