{
  lib,
  stdenv,
  writeShellApplication,
  writeText,
  symlinkJoin,
  docker,
  socat,
  python3,
  coreutils,
  nixpkgsPath,
  onePasswordCli,
  realPi,
}:
let
  linuxSystem = "${stdenv.hostPlatform.parsed.cpu.name}-linux";
  pkgsLinux = import nixpkgsPath {
    system = linuxSystem;
    config.allowUnfree = true;
  };

  imageRevision = builtins.substring 0 12 (
    builtins.hashString "sha256" (builtins.readFile ./default.nix)
  );
  imageName = "luca/pi-sandbox";
  imageTag = "${realPi.version}-${imageRevision}";
  imageRef = "${imageName}:${imageTag}";

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

  opBridgeClientScript = pkgsLinux.writeText "pi-op-bridge-client.py" ''
    import base64
    import http.client
    import json
    import os
    import sys

    port = int(os.environ["PI_SANDBOX_OP_PORT"])
    token = os.environ["PI_SANDBOX_OP_TOKEN"]
    stdin = b"" if os.isatty(0) else sys.stdin.buffer.read()
    env = {key: value for key, value in os.environ.items() if key.startswith("OP_")}
    body = json.dumps({
        "args": sys.argv[1:],
        "stdin": base64.b64encode(stdin).decode(),
        "env": env,
    })

    try:
        connection = http.client.HTTPConnection("host.docker.internal", port)
        connection.request(
            "POST",
            "/",
            body=body,
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        payload = json.loads(response.read())
        if response.status != 200:
            raise RuntimeError(payload.get("error", "bridge returned HTTP " + str(response.status)))
        sys.stdout.buffer.write(base64.b64decode(payload["stdout"]))
        sys.stderr.buffer.write(base64.b64decode(payload["stderr"]))
        raise SystemExit(payload["status"])
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print("op: 1Password desktop bridge failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
  '';

  opBridgeClient = pkgsLinux.writeShellApplication {
    name = "op";
    runtimeInputs = [ pkgsLinux.python3 ];
    text = ''
      exec ${pkgsLinux.python3}/bin/python3 ${opBridgeClientScript} "$@"
    '';
  };

  containerEntrypoint = pkgsLinux.writeShellApplication {
    name = "pi-sandbox-entrypoint";
    runtimeInputs = [
      pkgsLinux.coreutils
      pkgsLinux.socat
    ];
    text = ''
      mkdir -p /run/host-services /run/user/0
      chmod 700 /run/user/0

      start_socket_relay() {
        local port="$1"
        local socket="$2"
        ${pkgsLinux.socat}/bin/socat \
          "UNIX-LISTEN:$socket,fork,mode=600" \
          "TCP:host.docker.internal:$port" &
        local pid=$!
        for _ in $(${pkgsLinux.coreutils}/bin/seq 1 100); do
          [[ -S "$socket" ]] && return
          kill -0 "$pid" 2>/dev/null || {
            wait "$pid" || true
            echo "pi: failed to create sandbox socket $socket" >&2
            exit 1
          }
          sleep 0.02
        done
        echo "pi: timed out creating sandbox socket $socket" >&2
        exit 1
      }

      if [[ -n "''${PI_SANDBOX_SSH_PORT:-}" ]]; then
        export SSH_AUTH_SOCK=/run/host-services/ssh-auth.sock
        start_socket_relay "$PI_SANDBOX_SSH_PORT" "$SSH_AUTH_SOCK"
      fi

      if [[ -n "''${PI_SANDBOX_OP_PORT:-}" ]]; then
        [[ -n "''${PI_SANDBOX_OP_TOKEN:-}" ]] || {
          echo "pi: missing 1Password bridge token" >&2
          exit 1
        }
        export PATH=${opBridgeClient}/bin:$PATH
      fi

      exec ${pkgsLinux.pi-coding-agent}/bin/pi "$@"
    '';
  };

  imagePackages = [
    containerEntrypoint
    opBridgeClient
    pkgsLinux.pi-coding-agent
    pkgsLinux._1password-cli
    pkgsLinux.docker-client
    pkgsLinux.openssh
    pkgsLinux.bashInteractive
    pkgsLinux.cacert
    pkgsLinux.coreutils
    pkgsLinux.findutils
    pkgsLinux.gnugrep
    pkgsLinux.gnused
    pkgsLinux.gawk
    pkgsLinux.git
    pkgsLinux.curl
    pkgsLinux.wget
    pkgsLinux.jq
    pkgsLinux.ripgrep
    pkgsLinux.socat
    pkgsLinux.fakeNss
  ];

  image = pkgsLinux.dockerTools.buildLayeredImage {
    name = imageName;
    tag = imageTag;
    created = "1970-01-01T00:00:01Z";
    contents = imagePackages;
    extraCommands = ''
      mkdir -p root/.pi/agent root/.cache root/.config/op workspace run/user/0 tmp
      chmod 700 root root/.pi root/.pi/agent root/.config root/.config/op
    '';
    config = {
      Entrypoint = [ "${containerEntrypoint}/bin/pi-sandbox-entrypoint" ];
      WorkingDir = "/workspace";
      Env = [
        "HOME=/root"
        "PATH=${lib.makeBinPath imagePackages}"
        "SSL_CERT_FILE=${pkgsLinux.cacert}/etc/ssl/certs/ca-bundle.crt"
        "NIX_SSL_CERT_FILE=${pkgsLinux.cacert}/etc/ssl/certs/ca-bundle.crt"
      ];
    };
  };

  wrapper = writeShellApplication {
    name = "pi";
    runtimeInputs = [
      coreutils
      docker
      python3
      socat
    ];
    text = ''
      sandbox=false
      docker_socket=false
      ssh_agent=false
      op_socket=false
      passthrough=false
      pi_args=()

      for arg in "$@"; do
        if $passthrough; then
          pi_args+=("$arg")
          continue
        fi
        case "$arg" in
          --sandbox) sandbox=true ;;
          --docker-socket) docker_socket=true ;;
          --ssh-agent) ssh_agent=true ;;
          --op-socket) op_socket=true ;;
          --)
            passthrough=true
            pi_args+=("$arg")
            ;;
          *) pi_args+=("$arg") ;;
        esac
      done

      if ! $sandbox; then
        if $docker_socket || $ssh_agent || $op_socket; then
          echo "pi: --docker-socket, --ssh-agent and --op-socket require --sandbox" >&2
          exit 2
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

      state_root="$HOME/.cache/pi-sandbox"
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

      if ! docker image inspect ${lib.escapeShellArg imageRef} >/dev/null 2>&1; then
        echo ":: loading ${imageRef}" >&2
        docker load < ${image} >&2
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
    inherit
      image
      imageRef
      opBridgeClient
      opBridgeServer
      ;
  };
}
