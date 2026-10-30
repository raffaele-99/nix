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
  gawk,
  _1password-cli,
  pi-coding-agent,
  nixpkgsRev,
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
  imageTag = "${pi-coding-agent.version}-${imageRevision}";
  imageRef = "${imageName}:${imageTag}";
  toolsetsKey = builtins.substring 0 16 (
    builtins.hashString "sha256" (
      nixpkgsRev + lib.concatMapStrings (path: "${path}") (lib.attrValues sandboxToolsets)
    )
  );

  # SYSTEM.md, extensions and themes are part of the package. The wrapper passes
  # them to pi as flags instead of installing them into ~/.pi/agent.
  agentConfig = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./SYSTEM.md
      ./extensions
      ./themes
    ];
  };

  sandboxGuidelines = writeText "pi-sandbox-guidelines.md" "- You can use `uv` if you need pip packages.";

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
                        ["${_1password-cli}/bin/op", *args],
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

    # The sandbox relays a loopback Caido's port, so the URL works unchanged there.
    relay_port = str(port or 80) if is_loopback else ""
    cache_key = hashlib.sha256(host_url.encode()).hexdigest()[:16]
    print("\t".join((host_url, cache_key, relay_port)))
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
      sandbox=true
      info=false
      docker_socket=false
      ssh_agent=false
      op_socket=false
      no_cwd=false
      no_extensions=false
      passthrough=false
      caido_url=""
      caido_cache_key=""
      caido_relay_port=""
      exposed_ports=()
      toolsets=()
      pi_args=()

      # --expose URL: a service on the host's loopback, such as Caido, is
      # reachable at the same URL in the sandbox. Nothing is routed through it.
      expose() {
        local pattern='^https?://(127\.0\.0\.1|localhost):([1-9][0-9]{0,4})/?$'
        if [[ ! "$1" =~ $pattern ]]; then
          echo "pi: --expose takes a loopback URL with a port, such as http://127.0.0.1:8080 (other hosts are reachable already)" >&2
          exit 2
        fi
        exposed_ports+=("''${BASH_REMATCH[2]}")
      }

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
          --no-sandbox)
            sandbox=false
            shift
            ;;
          -h | --help | -v | --version | --list-models)
            info=true
            pi_args+=("$1")
            shift
            ;;
          --export)
            if (( $# < 2 )) || [[ -z "$2" ]]; then
              echo "pi: --export requires a session file" >&2
              exit 2
            fi
            info=true
            pi_args+=("$1" "$2")
            shift 2
            ;;
          --provider | --model | --api-key | --system-prompt | --append-system-prompt | \
          --name | -n | --session | --session-id | --fork | --session-dir | --models | \
          --thinking | --extension | -e | --skill | --prompt-template | --theme | \
          -t | --exclude-tools | -xt | --mode | --use-theme | --tui-mode)
            # Pi consumes the next token as a value, not a wrapper or info flag.
            pi_args+=("$1")
            shift
            if (( $# > 0 )); then
              pi_args+=("$1")
              shift
            fi
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
          --no-extensions | -ne)
            no_extensions=true
            pi_args+=("$1")
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
          --expose)
            expose "''${2:-}"
            shift 2
            ;;
          --expose=*)
            expose "''${1#*=}"
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

      case "''${pi_args[0]:-}" in
        install | uninstall | remove | update | list | config | auth | mcp)
          exec ${pi-coding-agent}/bin/pi "''${pi_args[@]}"
          ;;
      esac

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
        IFS=$'\t' read -r caido_url caido_cache_key caido_relay_port <<< "$caido_details"
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

      # Prepends the packaged configuration, located at $1 as pi sees it.
      add_agent_config() {
        local root="$1" name
        local args=(--system-prompt "$root/SYSTEM.md" --theme "$root/themes")
        if ! $no_extensions; then
          for name in ${lib.escapeShellArgs (lib.attrNames (builtins.readDir ./extensions))}; do
            if [[ -e "$root/extensions/$name" ]]; then
              args+=(-e "$root/extensions/$name")
            fi
          done
        fi
        pi_args=("''${args[@]}" "''${pi_args[@]}")
      }

      state_root="$HOME/.cache/pi-sandbox"

      # pi's own requests go through Caido, trusting its CA.
      route_pi_through_caido() {
        local caido_dir="$state_root/caido/$caido_cache_key"
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
      }

      if $info || ! $sandbox; then
        add_agent_config ${agentConfig}
        if ! $info && { $docker_socket || $ssh_agent || $op_socket || (( ''${#toolsets[@]} + ''${#exposed_ports[@]} > 0 )); }; then
          echo "pi: --docker-socket, --ssh-agent, --op-socket, --tools and --expose don't work with --no-sandbox" >&2
          exit 2
        fi
        if [[ -n "$caido_url" ]]; then
          route_pi_through_caido
        fi
        if $no_cwd; then
          pi_args=(-e ${./no-cwd.ts} "''${pi_args[@]}")
        fi
        exec ${pi-coding-agent}/bin/pi "''${pi_args[@]}"
      fi

      command -v docker >/dev/null || {
        echo "pi: Docker is required for the sandbox; use --no-sandbox to run tools on the host" >&2
        exit 1
      }
      docker info >/dev/null 2>&1 || {
        echo "pi: Docker is unavailable; start Colima, or use --no-sandbox to run tools on the host" >&2
        exit 1
      }

      workspace="$(pwd -P)"
      host_agent="$HOME/.pi/agent"
      # The workspace is the only host directory the agent can reach.
      if [[ "$workspace" == / || "$host_agent/" == "$workspace"/* ]]; then
        echo "pi: refusing to mount $workspace in the sandbox: it contains $host_agent; use --no-sandbox to run tools on the host" >&2
        exit 2
      fi

      mkdir -p "$state_root"
      session_dir="$(mktemp -d "$state_root/session.XXXXXX")"
      chmod 700 "$session_dir"
      container="pi-sandbox-''${session_dir##*.}"
      container_started=false
      relay_pids=()

      cleanup() {
        local status=$?
        trap - EXIT INT TERM HUP
        if $container_started; then
          docker rm -f "$container" >/dev/null 2>&1 || true
        fi
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

      session_key="''${workspace#/}"
      session_key="''${session_key//\//-}"
      session_key="''${session_key//:/-}"
      session_key="--$session_key--"
      host_session_dir="$host_agent/sandbox-sessions/$session_key"
      mkdir -p "$host_session_dir"
      chmod 700 "$host_agent/sandbox-sessions" "$host_session_dir"

      # pi runs here, on the host, with its own config, credentials and
      # sessions. Its tools run in the container (sandbox-tools.ts), where the
      # workspace is the only host directory.
      cp -R ${agentConfig} "$session_dir/packaged"
      chmod -R u+w "$session_dir/packaged"
      # subagent.ts starts more pi processes, which would have host tools.
      rm -f "$session_dir/packaged/extensions/subagent.ts"

      add_sandbox_guidelines() {
        local system_prompt="$session_dir/packaged/SYSTEM.md"
        [[ -f "$system_prompt" ]] || return 0
        ${gawk}/bin/awk -v guidelines="$(cat ${sandboxGuidelines})" \
          '/<\/guidelines>/ { print guidelines } { print }' "$system_prompt" > "$system_prompt.new"
        mv -f "$system_prompt.new" "$system_prompt"
      }
      add_sandbox_guidelines
      add_agent_config "$session_dir/packaged"

      if $no_cwd; then
        pi_args=(-e ${./no-cwd.ts} "''${pi_args[@]}")
      fi

      docker_args=(
        run --detach --init --name "$container"
        --read-only
        --cap-drop=ALL
        --security-opt=no-new-privileges
        --tmpfs "/tmp:rw,nosuid,nodev,size=512m"
        --tmpfs "/run:rw,nosuid,nodev,size=16m"
        --tmpfs "/root/.cache:rw,nosuid,nodev,size=256m"
        --workdir /workspace
        --mount "type=bind,src=$workspace,dst=/workspace"
      )

      if [[ -e .git ]]; then
        docker_args+=(--mount "type=bind,src=$workspace/.git,dst=/workspace/.git,readonly")
      fi

      # pi lists skills by their host paths, so the agent reads read-only copies there.
      mount_skills() {
        local skills="$1" copy="$session_dir/$2"
        [[ -d "$skills" ]] || return 0
        cp -RL "$skills" "$copy"
        docker_args+=(--mount "type=bind,src=$copy,dst=$skills,readonly")
      }
      mount_skills "$host_agent/skills" pi-skills
      mount_skills "$HOME/.agents/skills" agents-skills

      host_ports=("''${exposed_ports[@]}")
      if [[ -n "$caido_url" ]]; then
        route_pi_through_caido
        # Tools in the container go through Caido as well.
        docker_args+=(
          --mount "type=bind,src=$caido_certificate,dst=/etc/caido-ca.crt,readonly"
          --env "PI_CAIDO_CA_CERT=/etc/caido-ca.crt"
          --env "HTTP_PROXY=$caido_url"
          --env "HTTPS_PROXY=$caido_url"
          --env "http_proxy=$caido_url"
          --env "https_proxy=$caido_url"
          --env "NO_PROXY="
          --env "no_proxy="
          --env "SSL_CERT_FILE=/run/caido-ca-bundle.crt"
          --env "NIX_SSL_CERT_FILE=/run/caido-ca-bundle.crt"
          --env "NODE_EXTRA_CA_CERTS=/run/caido-ca-bundle.crt"
          --env "CURL_CA_BUNDLE=/run/caido-ca-bundle.crt"
          --env "GIT_SSL_CAINFO=/run/caido-ca-bundle.crt"
          --env "REQUESTS_CA_BUNDLE=/run/caido-ca-bundle.crt"
        )
        if [[ -n "$caido_relay_port" ]]; then
          host_ports+=("$caido_relay_port")
        fi
      fi
      if (( ''${#host_ports[@]} > 0 )); then
        docker_args+=(--env "PI_SANDBOX_HOST_PORTS=$(printf '%s\n' "''${host_ports[@]}" | sort -un | paste -sd ' ' -)")
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
        docker_args+=(
          --env "PI_SANDBOX_SSH_PORT=$relay_port"
          --env SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock
        )
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

      container_started=true
      if ! docker "''${docker_args[@]}" ${lib.escapeShellArg imageRef} >/dev/null; then
        echo "pi: could not start the sandbox container for $workspace; use --no-sandbox to run tools on the host" >&2
        exit 1
      fi
      ready=false
      for _ in $(seq 50); do
        if docker exec "$container" test -e /run/pi-sandbox-ready 2>/dev/null; then
          ready=true
          break
        fi
        sleep 0.1
      done
      if ! $ready; then
        docker logs "$container" >&2 || true
        echo "pi: the sandbox container did not start" >&2
        exit 1
      fi

      # Built-in tools are off, so the agent has only the container's: if
      # sandbox-tools.ts fails to load, it has none. Workspace project files
      # and AGENTS.md are not read on the host.
      PI_SANDBOX_CONTAINER="$container" ${pi-coding-agent}/bin/pi \
        --no-builtin-tools --no-approve --no-context-files \
        --session-dir "$host_session_dir" \
        -e ${./sandbox-tools.ts} \
        "''${pi_args[@]}"
    '';
  };
in
symlinkJoin {
  name = "pi-sandbox-${pi-coding-agent.version}";
  paths = [
    pi-coding-agent
    wrapper
  ];
  postBuild = ''
    rm -f "$out/bin/pi"
    ln -s ${wrapper}/bin/pi "$out/bin/pi"
  '';
  meta = pi-coding-agent.meta // {
    description = "Pi coding agent whose tools run in a Docker sandbox unless --no-sandbox is given";
    mainProgram = "pi";
    platforms = lib.platforms.darwin;
  };
  passthru = {
    inherit imageRef opBridgeServer;
    imageExpression = ./image.nix;
  };
}
