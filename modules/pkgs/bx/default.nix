{
  lib,
  rustPlatform,
  fetchFromGitHub,
}:
rustPlatform.buildRustPackage rec {
  pname = "brave-search-cli";
  version = "1.7.0";

  src = fetchFromGitHub {
    owner = "brave";
    repo = "brave-search-cli";
    tag = "v${version}";
    hash = "sha256-xqZ1egxY1MiJIJjv4TmAUQqWK9zXLY+ZWxqmZ5XBjjU=";
  };

  cargoHash = "sha256-iKoGB9UcSXfTaCJvQ5wpShCtkT31iRzC+UmmIEkG3Ow=";

  doCheck = false;

  meta = {
    description = "Token-efficient CLI for the Brave Search API, built for AI agents and LLMs";
    homepage = "https://github.com/brave/brave-search-cli";
    license = lib.licenses.mpl20;
    mainProgram = "bx";
  };
}
