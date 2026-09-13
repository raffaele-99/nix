{
  config,
  lib,
  pkgs,
  ...
}:
let
  configureDocker = pkgs.writeShellScript "configure-docker-credentials" ''
    set -euo pipefail
    config_dir="$1/.docker"
    config_file="$config_dir/config.json"
    mkdir -p "$config_dir"
    tmp="$(mktemp "$config_dir/config.json.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT

    # Docker and Colima must be able to update this file, so do not manage
    # it as a read-only home.file symlink. Preserve contexts and login data.
    if [[ -e "$config_file" ]]; then
      ${pkgs.jq}/bin/jq '
        .credsStore = "osxkeychain"
        | if (.credHelpers | type) == "object" then
            .credHelpers |= with_entries(
              if .value == "desktop" then .value = "osxkeychain" else . end
            )
          else . end
      ' "$config_file" > "$tmp"
    else
      printf '%s\n' '{"credsStore":"osxkeychain"}' > "$tmp"
    fi
    chmod 600 "$tmp"
    mv "$tmp" "$config_file"
  '';
in
{
  home.packages = [ pkgs.docker-credential-helpers ];

  home.activation.dockerCredentials = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    run ${configureDocker} ${lib.escapeShellArg config.home.homeDirectory}
  '';
}
