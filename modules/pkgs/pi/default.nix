{
  lib,
  callPackage,
  writeShellApplication,
  writeText,
  symlinkJoin,
  cacert,
  curl,
  docker,
  openssl,
  socat,
  python3,
  coreutils,
  gnused,
  nixpkgsRev,
  onePasswordCli,
  realPi,
  bxs ? callPackage ../../../pkgs/bxs { },
  sandboxToolsets ? import ./toolsets,
}:
assert lib.all (name: builtins.match "[a-zA-Z0-9][a-zA-Z0-9_-]*" name != null) (
  lib.attrNames sandboxToolsets
);
let
  imageRevision = builtins.substring 0 12 (
    builtins.hashString "sha256" "${nixpkgsRev}:${builtins.readFile ./image.nix}"
  );
  imageName = "luca/pi-sandbox";
  imageTag = "${realPi.version}-${imageRevision}";
  imageRef = "${imageName}:${imageTag}";
  toolsetsKey = builtins.substring 0 16 (
    builtins.hashString "sha256" (
      nixpkgsRev + lib.concatMapStrings (path: "${path}") (lib.attrValues sandboxToolsets)
    )
  );

  # The desktop app authenticates the peer connected to s.sock, so a raw socat
  # relay is rejected. This narrow RPC bridge executes the signed host op CLI
  # while preventing access to host paths and host-side process execution.
  opBridgeServer = writeText "pi-op-bridge-server.py" ''
    import base64
    import hmac
    import http.server
    import json
    import os
    import re
    import subprocess
    import tempfile

    TOKEN = os.environ["PI_OP_BRIDGE_TOKEN"]
    PORT = int(os.environ["PI_OP_BRIDGE_PORT"])
    MAX_REQUEST = 64 * 1024 * 1024
    VALUE_FLAGS = {"--account", "--encoding", "--format", "--session"}
    FORBIDDEN_COMMANDS = {"connect", "plugin", "run", "signin", "signout", "update"}
    FILE_FLAGS = {"-i", "--in-file", "-o", "--out-file", "--template"}
    PASSTHROUGH_ENV = {
        "OP_ACCOUNT",
        "OP_CACHE",
        "OP_DEBUG",
        "OP_ENCODING",
        "OP_FORMAT",
        "OP_INCLUDE_ARCHIVE",
        "OP_ISO_TIMESTAMPS",
        "OP_SESSION",
    }


    def command_words(args):
        words = []
        skip = False
        for arg in args:
            if skip:
                skip = False
                continue
            if arg in VALUE_FLAGS:
                skip = True
                continue
            if arg.startswith("-"):
                continue
            words.append(arg)
        return words


    def validate(args):
        for arg in args:
            if arg == "--config" or arg.startswith("--config="):
                return "--config is unavailable through the sandbox bridge"
            if arg in FILE_FLAGS or any(arg.startswith(flag + "=") for flag in FILE_FLAGS):
                return "host file options are unavailable; use stdin/stdout inside the sandbox"
            if re.search(r"\[file\]=", arg, re.IGNORECASE):
                return "item file attachments are unavailable through the sandbox bridge"

        words = command_words(args)
        if not words:
            return None
        command = words[0]
        if command in FORBIDDEN_COMMANDS:
            return f"op {command} is unavailable because it would modify host state or execute on the host"
        if command == "account" and (len(words) < 2 or words[1] not in {"get", "list"}):
            return "only 'op account get' and 'op account list' are available through the sandbox bridge"
        if command == "document" and len(words) >= 2 and words[1] in {"create", "edit"} and "-" not in args:
            return "op document create/edit must read document data from stdin in the sandbox"
        return None


    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
                self.send_error(403)
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400)
                return
            if size < 0 or size > MAX_REQUEST:
                self.send_error(413)
                return

            try:
                request = json.loads(self.rfile.read(size))
                args = request["args"]
                if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
                    raise ValueError("args must be a list of strings")
                stdin = base64.b64decode(request.get("stdin", ""), validate=True)
                error = validate(args)
                if error:
                    result = {"status": 2, "stdout": "", "stderr": base64.b64encode(("op: " + error + "\n").encode()).decode()}
                else:
                    env = os.environ.copy()
                    env.pop("PI_OP_BRIDGE_TOKEN", None)
                    env.pop("PI_OP_BRIDGE_PORT", None)
                    env["OP_BIOMETRIC_UNLOCK_ENABLED"] = "true"
                    for key, value in request.get("env", {}).items():
                        if key in PASSTHROUGH_ENV and isinstance(value, str):
                            env[key] = value
                    completed = subprocess.run(
                        ["${onePasswordCli}/bin/op", *args],
                        input=stdin,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        cwd=tempfile.gettempdir(),
                        env=env,
                        check=False,
                    )
                    result = {
                        "status": completed.returncode,
                        "stdout": base64.b64encode(completed.stdout).decode(),
                        "stderr": base64.b64encode(completed.stderr).decode(),
                    }
                body = json.dumps(result).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as error:
                body = json.dumps({"error": str(error)}).encode()
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)


    class Server(http.server.ThreadingHTTPServer):
        daemon_threads = True


    Server(("127.0.0.1", PORT), Handler).serve_forever()
  '';

  caidoUrlResolver = writeText "pi-caido-url.py" ''
    import hashlib
    import ipaddress
    import sys
    from urllib.parse import urlsplit, urlunsplit


    def fail(message):
        print(f"pi: invalid --caido-url: {message}", file=sys.stderr)
        raise SystemExit(2)


    value = sys.argv[1].strip()
    if any(character.isspace() for character in value):
        fail("whitespace is not allowed")

    parsed = urlsplit(value)
    if parsed.scheme.lower() != "http":
        fail("the proxy URL must use http://")
    if not parsed.hostname:
        fail("a hostname is required")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        fail("paths, queries, and fragments are not supported")
    try:
        port = parsed.port
    except ValueError as error:
        fail(str(error))

    host_url = urlunsplit(("http", parsed.netloc, "", "", ""))
    hostname = parsed.hostname.lower()
    is_loopback = hostname == "localhost"
    try:
        is_loopback = is_loopback or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        pass

    container_netloc = parsed.netloc
    if is_loopback:
        userinfo, separator, _host_port = parsed.netloc.rpartition("@")
        container_netloc = (userinfo + separator if separator else "") + "host.docker.internal"
        if port is not None:
            container_netloc += f":{port}"

    container_url = urlunsplit(("http", container_netloc, "", "", ""))
    cache_key = hashlib.sha256(host_url.encode()).hexdigest()[:16]
    print("\t".join((host_url, container_url, cache_key)))
  '';

  wrapper = writeShellApplication {
    name = "pi";
    runtimeInputs = [
      coreutils
      gnused
      curl
      docker
      openssl
      python3
      socat
    ];
    text = ''
      sandbox=false
      docker_socket=false
      ssh_agent=false
      op_socket=false
      no_cwd=false
      passthrough=false
      caido_url=""
      caido_container_url=""
      caido_cache_key=""
      toolsets=()
      pi_args=()

      while (( $# > 0 )); do
        if $passthrough; then
          pi_args+=("$1")
          shift
          continue
        fi
        case "$1" in
          --sandbox)
            sandbox=true
            shift
            ;;
          --tools)
            if (( $# < 2 )) || [[ -z "$2" || "$2" == --* ]]; then
              echo "pi: --tools requires a registered toolset name" >&2
              exit 2
            fi
            toolsets+=("$2")
            shift 2
            ;;
          --tools=*)
            toolsets+=("''${1#*=}")
            shift
            ;;
          --docker-socket)
            docker_socket=true
            shift
            ;;
          --ssh-agent)
            ssh_agent=true
            shift
            ;;
          --op-socket)
            op_socket=true
            shift
            ;;
          --no-cwd)
            no_cwd=true
            shift
            ;;
          --caido-url)
            if (( $# < 2 )) || [[ -z "$2" || "$2" == --* ]]; then
              echo "pi: --caido-url requires an HTTP URL" >&2
              exit 2
            fi
            caido_url="$2"
            shift 2
            ;;
          --caido-url=*)
            caido_url="''${1#*=}"
            if [[ -z "$caido_url" ]]; then
              echo "pi: --caido-url requires an HTTP URL" >&2
              exit 2
            fi
            shift
            ;;
          --)
            passthrough=true
            pi_args+=("$1")
            shift
            ;;
          *)
            pi_args+=("$1")
            shift
            ;;
        esac
      done

      for toolset in "''${toolsets[@]}"; do
        case "$toolset" in
          ${lib.concatMapStringsSep "\n" (name: ''
            ${lib.escapeShellArg name}) ;;
          '') (lib.attrNames sandboxToolsets)}
          *)
            echo "pi: unknown toolset '$toolset'; available: ${lib.concatStringsSep ", " (lib.attrNames sandboxToolsets)}" >&2
            exit 2
            ;;
        esac
      done

      if [[ -n "$caido_url" ]]; then
        caido_details="$(${python3}/bin/python3 ${caidoUrlResolver} "$caido_url")"
        IFS=$'\t' read -r caido_url caido_container_url caido_cache_key <<< "$caido_details"
      fi

      fetch_caido_certificate() {
        local destination="$1"
        local temporary
        temporary="$(mktemp "$destination.tmp.XXXXXX")"
        if ! ${curl}/bin/curl \
          --fail \
          --silent \
          --show-error \
          --location \
          --noproxy '*' \
          --connect-timeout 3 \
          --max-time 10 \
          --output "$temporary" \
          "$caido_url/ca.crt"; then
          rm -f "$temporary"
          echo "pi: failed to download Caido CA certificate from $caido_url/ca.crt" >&2
          exit 1
        fi
        if ! ${openssl}/bin/openssl x509 -in "$temporary" -noout >/dev/null 2>&1; then
          rm -f "$temporary"
          echo "pi: $caido_url/ca.crt did not return a valid PEM certificate" >&2
          exit 1
        fi
        chmod 600 "$temporary"
        mv -f "$temporary" "$destination"
      }

      build_caido_bundle() {
        local certificate="$1"
        local destination="$2"
        local temporary
        temporary="$(mktemp "$destination.tmp.XXXXXX")"
        cat ${cacert}/etc/ssl/certs/ca-bundle.crt "$certificate" > "$temporary"
        chmod 600 "$temporary"
        mv -f "$temporary" "$destination"
      }

      state_root="$HOME/.cache/pi-sandbox"

      if ! $sandbox; then
        if $docker_socket || $ssh_agent || $op_socket || (( ''${#toolsets[@]} > 0 )); then
          echo "pi: --docker-socket, --ssh-agent, --op-socket and --tools require --sandbox" >&2
          exit 2
        fi
        if [[ -n "$caido_url" ]]; then
          caido_dir="$state_root/caido/$caido_cache_key"
          mkdir -p "$caido_dir"
          chmod 700 "$state_root/caido" "$caido_dir"
          caido_certificate="$caido_dir/ca.crt"
          caido_bundle="$caido_dir/ca-bundle.crt"
          fetch_caido_certificate "$caido_certificate"
          build_caido_bundle "$caido_certificate" "$caido_bundle"
          export HTTP_PROXY="$caido_url"
          export HTTPS_PROXY="$caido_url"
          export http_proxy="$caido_url"
          export https_proxy="$caido_url"
          export NO_PROXY=""
          export no_proxy=""
          export SSL_CERT_FILE="$caido_bundle"
          export NIX_SSL_CERT_FILE="$caido_bundle"
          export NODE_EXTRA_CA_CERTS="$caido_bundle"
          export CURL_CA_BUNDLE="$caido_bundle"
          export GIT_SSL_CAINFO="$caido_bundle"
          export REQUESTS_CA_BUNDLE="$caido_bundle"
          pi_args=(-e ${./caido-openrouter.ts} "''${pi_args[@]}")
        fi
        if $no_cwd; then
          pi_args=(-e ${./no-cwd.ts} "''${pi_args[@]}")
        fi
        exec ${realPi}/bin/pi "''${pi_args[@]}"
      fi

      command -v docker >/dev/null || {
        echo "pi: Docker is required for --sandbox" >&2
        exit 1
      }
      docker info >/dev/null 2>&1 || {
        echo "pi: Docker is unavailable; ensure Colima is running" >&2
        exit 1
      }

      mkdir -p "$state_root"
      session_dir="$(mktemp -d "$state_root/session.XXXXXX")"
      chmod 700 "$session_dir"
      relay_pids=()

      cleanup() {
        local status=$?
        trap - EXIT INT TERM HUP
        for pid in "''${relay_pids[@]}"; do
          kill "$pid" 2>/dev/null || true
          wait "$pid" 2>/dev/null || true
        done
        rm -rf "$session_dir"
        exit "$status"
      }
      trap cleanup EXIT INT TERM HUP

      allocate_port() {
        ${python3}/bin/python3 -c 'import socket; sock = socket.socket(); sock.bind(("127.0.0.1", 0)); print(sock.getsockname()[1]); sock.close()'
      }

      relay_port=""
      start_host_relay() {
        local socket="$1"
        local name="$2"
        [[ -S "$socket" ]] || {
          echo "pi: $name socket does not exist: $socket" >&2
          exit 1
        }
        relay_port="$(allocate_port)"
        ${socat}/bin/socat \
          "TCP-LISTEN:$relay_port,bind=127.0.0.1,reuseaddr,fork" \
          "UNIX-CONNECT:$socket" \
          >"$session_dir/$name-relay.log" 2>&1 &
        local pid=$!
        relay_pids+=("$pid")
        sleep 0.05
        kill -0 "$pid" 2>/dev/null || {
          cat "$session_dir/$name-relay.log" >&2 || true
          echo "pi: failed to start $name socket relay" >&2
          exit 1
        }
      }

      workspace="$(pwd -P)"
      agent_dir="$session_dir/agent"
      host_agent="$HOME/.pi/agent"
      session_key="''${workspace#/}"
      session_key="''${session_key//\//-}"
      session_key="''${session_key//:/-}"
      session_key="--$session_key--"
      host_session_dir="$host_agent/sandbox-sessions/$session_key"
      mkdir -p "$agent_dir/sessions/--workspace--" "$host_session_dir"
      chmod 700 "$host_agent/sandbox-sessions" "$host_session_dir"

      copy_agent_item() {
        local name="$1"
        if [[ -e "$host_agent/$name" ]]; then
          cp -RL "$host_agent/$name" "$agent_dir/$name"
        elif [[ -L "$host_agent/$name" ]]; then
          echo "pi: skipping broken config symlink $host_agent/$name" >&2
        fi
      }

      for name in SYSTEM.md APPEND_SYSTEM.md settings.json models.json trust.json extensions skills prompts themes; do
        copy_agent_item "$name"
      done

      # Sandbox-only guideline, added to the container's copy of SYSTEM.md.
      if [[ -f "$agent_dir/SYSTEM.md" ]]; then
        chmod u+w "$agent_dir/SYSTEM.md"
        # shellcheck disable=SC2016 # backticks are literal markdown
        sed -i '/<\/guidelines>/i - You can use `uv` if you need pip packages.' "$agent_dir/SYSTEM.md"
      fi

      if $no_cwd; then
        install -m 0444 ${./no-cwd.ts} "$agent_dir/no-cwd.ts"
        pi_args=(-e /root/.pi/agent/no-cwd.ts "''${pi_args[@]}")
      fi

      if [[ -n "$caido_url" ]]; then
        fetch_caido_certificate "$agent_dir/caido-ca.crt"
        install -m 0444 ${./caido-openrouter.ts} "$agent_dir/caido-openrouter.ts"
        pi_args=(-e /root/.pi/agent/caido-openrouter.ts "''${pi_args[@]}")
      fi

      global_agents_dir="$session_dir/home-agents"
      mkdir -p "$global_agents_dir"
      if [[ -d "$HOME/.agents/skills" ]]; then
        cp -RL "$HOME/.agents/skills" "$global_agents_dir/skills"
      fi

      docker_args=(
        run --rm -i
        --read-only
        --cap-drop=ALL
        --security-opt=no-new-privileges
        --tmpfs "/tmp:rw,nosuid,nodev,size=512m"
        --tmpfs "/run:rw,nosuid,nodev,size=16m"
        --tmpfs "/root/.cache:rw,nosuid,nodev,size=256m"
        --workdir /workspace
        --mount "type=bind,src=$workspace,dst=/workspace"
        --mount "type=bind,src=$agent_dir,dst=/root/.pi/agent"
        --mount "type=bind,src=$global_agents_dir,dst=/root/.agents"
        --mount "type=bind,src=$host_session_dir,dst=/root/.pi/agent/sessions/--workspace--"
      )

      if [[ -t 0 && -t 1 ]]; then
        docker_args+=(-t)
      fi

      if [[ -e .git ]]; then
        docker_args+=(--mount "type=bind,src=$workspace/.git,dst=/workspace/.git,readonly")
      fi

      if [[ -f "$host_agent/auth.json" ]]; then
        : > "$agent_dir/auth.json"
        docker_args+=(--mount "type=bind,src=$host_agent/auth.json,dst=/root/.pi/agent/auth.json")
      fi
      if [[ -f "$host_agent/models-store.json" ]]; then
        : > "$agent_dir/models-store.json"
        docker_args+=(--mount "type=bind,src=$host_agent/models-store.json,dst=/root/.pi/agent/models-store.json")
      fi
      if [[ -n "$caido_url" ]]; then
        docker_args+=(
          --env "HTTP_PROXY=$caido_container_url"
          --env "HTTPS_PROXY=$caido_container_url"
          --env "http_proxy=$caido_container_url"
          --env "https_proxy=$caido_container_url"
          --env "NO_PROXY="
          --env "no_proxy="
          --env "PI_CAIDO_CA_CERT=/root/.pi/agent/caido-ca.crt"
        )
      fi
      if $docker_socket; then
        docker_args+=(
          --mount "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock"
          --env DOCKER_HOST=unix:///var/run/docker.sock
        )
      fi

      if $ssh_agent; then
        [[ -n "''${SSH_AUTH_SOCK:-}" ]] || {
          echo "pi: SSH_AUTH_SOCK is not set" >&2
          exit 1
        }
        start_host_relay "$SSH_AUTH_SOCK" ssh-agent
        docker_args+=(--env "PI_SANDBOX_SSH_PORT=$relay_port")
      fi

      if $op_socket; then
        op_socket_path="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/s.sock"
        [[ -S "$op_socket_path" ]] || {
          echo "pi: 1Password desktop integration socket does not exist: $op_socket_path" >&2
          exit 1
        }

        relay_port="$(allocate_port)"
        op_token="$(${python3}/bin/python3 -c 'import secrets; print(secrets.token_hex(32))')"
        PI_OP_BRIDGE_PORT="$relay_port" PI_OP_BRIDGE_TOKEN="$op_token" \
          ${python3}/bin/python3 ${opBridgeServer} \
          >"$session_dir/1password-bridge.log" 2>&1 &
        bridge_pid=$!
        relay_pids+=("$bridge_pid")
        sleep 0.1
        kill -0 "$bridge_pid" 2>/dev/null || {
          cat "$session_dir/1password-bridge.log" >&2 || true
          echo "pi: failed to start 1Password desktop bridge" >&2
          exit 1
        }
        docker_args+=(
          --env "PI_SANDBOX_OP_PORT=$relay_port"
          --env "PI_SANDBOX_OP_TOKEN=$op_token"
        )
      fi

      search_port="$(allocate_port)"
      search_token="$(${openssl}/bin/openssl rand -hex 32)"
      BXS_SERVE_TOKEN="$search_token" ${bxs}/bin/bxs serve --listen "127.0.0.1:$search_port" \
        >"$session_dir/search-bridge.log" 2>&1 &
      relay_pids+=("$!")
      docker_args+=(
        --env "PI_SANDBOX_SEARCH_PORT=$search_port"
        --env "PI_SANDBOX_SEARCH_TOKEN=$search_token"
      )

      if ! docker image inspect ${lib.escapeShellArg imageRef} >/dev/null 2>&1; then
        echo ":: building ${imageRef} with Docker's Linux VM" >&2
        image_expression="$state_root/image.nix"
        install -m 0444 ${./image.nix} "$image_expression"
        docker run --rm --platform linux/arm64 \
          --mount "type=bind,src=$image_expression,dst=/src/image.nix,readonly" \
          --mount "type=volume,src=luca-pi-sandbox-nix,dst=/nix" \
          --entrypoint /bin/sh \
          nixos/nix:2.31.2 -c '
            set -eu
            out="$(nix-build /src/image.nix --no-out-link --option sandbox false \
              --argstr nixpkgsRev "$1" --argstr imageTag "$2")"
            cat "$out"
          ' pi-image ${lib.escapeShellArg nixpkgsRev} ${lib.escapeShellArg imageTag} \
          | docker load >&2
      fi

      if (( ''${#toolsets[@]} > 0 )); then
        toolsets_dir="$session_dir/toolsets"
        mkdir -p "$toolsets_dir"
        install -m 0444 ${./prepare-tools.sh} "$toolsets_dir/prepare-tools.sh"
        for toolset in "''${toolsets[@]}"; do
          [[ ! -e "$toolsets_dir/$toolset" ]] || continue
          case "$toolset" in
            ${lib.concatMapStringsSep "\n" (name: ''
              ${lib.escapeShellArg name})
                cp -RL ${lib.escapeShellArg "${sandboxToolsets.${name}}"} "$toolsets_dir/$toolset"
                chmod -R u+w "$toolsets_dir/$toolset"
                ;;
            '') (lib.attrNames sandboxToolsets)}
          esac
        done

        echo ":: provisioning sandbox tools: ''${toolsets[*]}" >&2
        docker run --rm --platform linux/arm64 \
          --mount "type=bind,src=$toolsets_dir,dst=/toolsets,readonly" \
          --mount "type=volume,src=luca-pi-sandbox-nix,dst=/nix" \
          --entrypoint /bin/sh \
          nixos/nix:2.31.2 /toolsets/prepare-tools.sh \
          ${lib.escapeShellArg nixpkgsRev} ${lib.escapeShellArg toolsetsKey} \
          "''${toolsets[@]}" > "$session_dir/tools.manifest"

        # Bind mounts use paths on the Docker daemon's Linux filesystem, so
        # both directory and regular-file store objects can be exposed.
        nix_volume_root="$(docker volume inspect luca-pi-sandbox-nix --format '{{.Mountpoint}}')"
        sandbox_path="$(docker image inspect ${lib.escapeShellArg imageRef} \
          --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PATH=//p')"
        tool_bins=()
        closure_paths=()
        while IFS=$'\t' read -r kind path; do
          case "$kind" in
            bin) tool_bins+=("$path") ;;
            mount) closure_paths+=("$path") ;;
          esac
        done < "$session_dir/tools.manifest"
        while IFS= read -r path; do
          docker_args+=(--mount "type=bind,src=$nix_volume_root/''${path#/nix/},dst=$path,readonly")
        done < <(printf '%s\n' "''${closure_paths[@]}" | sort -u)
        for tool_bin in "''${tool_bins[@]}"; do
          sandbox_path="$tool_bin:$sandbox_path"
        done
        docker_args+=(
          --env "PATH=$sandbox_path"
          --env XDG_CONFIG_HOME=/root/.cache/config
        )
      fi

      docker "''${docker_args[@]}" ${lib.escapeShellArg imageRef} "''${pi_args[@]}"
    '';
  };
in
symlinkJoin {
  name = "pi-sandbox-${realPi.version}";
  paths = [
    realPi
    wrapper
  ];
  postBuild = ''
    rm -f "$out/bin/pi"
    ln -s ${wrapper}/bin/pi "$out/bin/pi"
  '';
  meta = realPi.meta // {
    description = "Pi coding agent with an opt-in Docker sandbox";
    mainProgram = "pi";
    platforms = lib.platforms.darwin;
  };
  passthru = {
    inherit imageRef opBridgeServer;
    imageExpression = ./image.nix;
  };
}
