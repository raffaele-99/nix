{
  docker,
  writeShellApplication,
}:
writeShellApplication {
  name = "scanhaus";
  runtimeInputs = [ docker ];
  text = ''
    source_dir="''${SCANHAUS_SOURCE:-$HOME/source/personal/scanhaus}"
    if [[ ! -f "$source_dir/pyproject.toml" || ! -f "$source_dir/uv.lock" || ! -d "$source_dir/src/scanhaus" ]]; then
      echo "scanhaus checkout not found at $source_dir; set SCANHAUS_SOURCE to its path" >&2
      exit 1
    fi

    build_context="$(mktemp -d)"
    trap 'rm -rf "$build_context"' EXIT
    cp "$source_dir/pyproject.toml" "$source_dir/uv.lock" "$source_dir/README.md" "$source_dir/.python-version" "$build_context/"
    cp -R "$source_dir/src" "$build_context/src"

    image=scanhaus:local
    docker build --quiet --tag "$image" --file ${./Dockerfile} "$build_context" >/dev/null
    rm -rf "$build_context"
    trap - EXIT

    docker_flags=(--rm --interactive)
    if [[ -t 0 && -t 1 ]]; then
      docker_flags+=(--tty)
    fi

    exec docker run "''${docker_flags[@]}" \
      --mount "type=bind,source=$PWD,target=/work,readonly" \
      --workdir /work \
      --mount "type=volume,source=scanhaus-cache,target=/root/.scanhaus" \
      --mount "type=volume,source=scanhaus-config,target=/root/.config/scanhaus" \
      --env MERKLEMAP_API_KEY \
      --env SCANHAUS_CONFIG_DIR=/root/.config/scanhaus \
      "$image" "$@"
  '';
}
