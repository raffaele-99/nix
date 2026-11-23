# pi-sandbox

macos pi wrapper to handle sandboxing and stuff

## usage

- `pi`: pi's tools in container
- `pi --tools re`: pi's tools in container with tools installed
- `pi --no-sandbox`: plain pi, tools on the host

## flags

- `--no-sandbox`: run the agent's tools on the host
- `--tools NAME`: add toolset, repeatable
- `--docker-socket`: expose host docker socket
- `--ssh-agent`: relay host ssh agent
- `--op-socket`: restricted 1password cli bridge
- `--caido-url URL`: proxy pi via caido + trust its ca
- `--expose URL`: make a host loopback service reachable at the same url, repeatable
- `--no-cwd`: strip cwd from system prompt

all flags except `--caido-url` and `--no-cwd` need the sandbox. everything else passes through to pi.

## docs

- [sandbox](./docs/SANDBOX.md)
- [toolsets](./docs/TOOLSETS.md)
- [extensions](./docs/EXTENSIONS.md)
