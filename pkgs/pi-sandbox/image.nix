{
  nixpkgsRev,
  imageTag,
}:
let
  pkgs =
    import
      (builtins.fetchTarball {
        url = "https://github.com/NixOS/nixpkgs/archive/${nixpkgsRev}.tar.gz";
      })
      {
        system = "aarch64-linux";
        config.allowUnfree = true;
      };
  inherit (pkgs) lib;
  imageName = "luca/pi-sandbox";

  opBridgeClientScript = pkgs.writeText "pi-op-bridge-client.py" ''
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

  opBridgeClient = pkgs.writeShellApplication {
    name = "op";
    runtimeInputs = [ pkgs.python3 ];
    text = ''
      exec ${pkgs.python3}/bin/python3 ${opBridgeClientScript} "$@"
    '';
  };

  containerEntrypoint = pkgs.writeShellApplication {
    name = "pi-sandbox-entrypoint";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.socat
    ];
    text = ''
      mkdir -p /run/host-services /run/user/0
      chmod 700 /run/user/0

      start_socket_relay() {
        local port="$1"
        local socket="$2"
        ${pkgs.socat}/bin/socat \
          "UNIX-LISTEN:$socket,fork,mode=600" \
          "TCP:host.docker.internal:$port" &
        local pid=$!
        for _ in $(${pkgs.coreutils}/bin/seq 1 100); do
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

      exec ${pkgs.pi-coding-agent}/bin/pi "$@"
    '';
  };

  imagePackages = [
    containerEntrypoint
    opBridgeClient
    pkgs.pi-coding-agent
    pkgs._1password-cli
    pkgs.docker-client
    pkgs.openssh
    pkgs.bashInteractive
    pkgs.cacert
    pkgs.coreutils
    pkgs.findutils
    pkgs.gnugrep
    pkgs.gnused
    pkgs.gawk
    pkgs.git
    pkgs.curl
    pkgs.wget
    pkgs.jq
    pkgs.ripgrep
    pkgs.socat
    pkgs.fakeNss
  ];

  image = pkgs.dockerTools.buildLayeredImage {
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
        "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
        "NIX_SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
      ];
    };
  };
in
image
