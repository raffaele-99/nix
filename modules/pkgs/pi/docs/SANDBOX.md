# SANDBOX

Sandboxing is on by default and you use `--no-sandbox` to disable it.

## Details

When you run `pi`, the current directory will be mounted into a container (rw) at `/workspace`. When you close `pi`, that container will be deleted.

> [!WARNING]
> If your cwd is `/` or contains `$HOME/.pi/agent`, it will refuse to run.
> So you should pass `--no-sandbox` if you want to run `pi` on the host in these dirs.

### Container

On invocation a wrapper script will check if `luca/pi-sandbox` image exists on your system. If not, the image is built and cached inside the `luca-pi-sandbox-nix` Docker volume. Then future invocations will create a container using this image.

The container has a read-only root and `--cap-drop=ALL` + `--security-opt=no-new-privileges`. Some tmpfs mounts are writable inside the container so that it can install tooling. (I need a better solution for this but it works enough right now).

### .git

If a `.git` directory is present, then it will also be mounted so the agent can make commits. However there are some caveats.

- `.git` files are read-only.
- `.git/config` and `.git/hooks` are read-only because the host's `git` would run them (sbox escape).
- `.git` itself is a mount point, which means it can't be moved or replaced from inside the container.
- Symlinks at `.git`, `.git/config`, or `.git/hooks` are refused.

## How it works

Pi will run on the host but Pi's built-in tools are disabled and replaced with containerised facsimiles.

Under the hood it uses `--no-builtin-tools` and then re-registers the exact same tools via the `sandbox/sandbox-tools.ts` extension. These tools are identical to the builtins except they will all run inside a Docker container via `docker exec`. 

The main reason for doing it this way rather than just running `pi` inside a container is because Im too lazy to figure out how to reliably and securely mount my extensions, prompts, auth tokens, etc into a container. If `pi` runs on the host then it is all set up already.

### Exceptions

The `web_search` tool still runs directly on the host, because if I ran that in the container then I would need to mount my Brave API key as well which I don't want to do.

### Limitations

If you have a `.pi/` directory in the current folder, it will be ignored. (I can't remember why I did this, but there was a reason.)

## Host reachability

By default the container can't reach the host. If you need to expose a host's port to the container, you can do something like:

```
pi --expose http://127.0.0.1:8080
```

Then the container can do, for example, `curl -x http://127.0.0.1:8080 example.com` to proxy its traffic through your host.

### Caido

There is fully slopped Caido support that auto-installs the Caido CA into the container and does some other stuff to make it easier.

```
pi --caido-url http://127.0.0.1:8080
```

Passing this flag will enable `extensions/optional/caido-openrouter.ts`.

## Files

- `sandbox/image.nix`: container image + entrypoint (socat relays, caido CA bundle, `op` bridge client)
- `sandbox/sandbox-tools.ts`: host-side extension that runs tools in the container via `docker exec`
- `sandbox/prepare-tools.sh`: builds requested toolsets in the linux nix store and emits a mount manifest
