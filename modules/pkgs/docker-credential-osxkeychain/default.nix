{
  fetchurl,
  runCommandLocal,
  stdenv,
}:
let
  # Keychain items trust this helper by cdhash, and the nixpkgs build gets a new
  # one whenever its inputs change, so every flake update meant another
  # password prompt. Upstream's prebuilt binary only changes when this version
  # is bumped; after a bump, choose "Always Allow" once.
  version = "0.9.12";
  arch =
    {
      aarch64-darwin = {
        name = "arm64";
        hash = "sha256-DkPsItP9GGstaaPHb9msChrk7E8sKy5O4VbgSMgljLA=";
      };
      x86_64-darwin = {
        name = "amd64";
        hash = "sha256-KyfTStIGWjQTdAtZNZ2sVvLhvQCkBineUeKfowzxOQ8=";
      };
    }
    .${stdenv.hostPlatform.system};
  binary = fetchurl {
    url = "https://github.com/docker/docker-credential-helpers/releases/download/v${version}/docker-credential-osxkeychain-v${version}.darwin-${arch.name}";
    inherit (arch) hash;
  };
in
# runCommand skips fixup, so the binary is never stripped or re-signed.
runCommandLocal "docker-credential-osxkeychain-${version}" { } ''
  install -Dm755 ${binary} $out/bin/docker-credential-osxkeychain
''
