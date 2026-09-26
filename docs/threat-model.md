# The Docker socket and what the panel can do

Dockge2 manages stacks through the Docker socket, `/var/run/docker.sock`, mounted into its
container. This page explains what that access amounts to, who reaches it through the panel, and
what limits it.

## The socket is root on the host

Whoever can talk to the Docker daemon can start a container that mounts `/` of the host, runs
privileged, or joins the host network and PID namespace. Access to the socket is therefore access
to the host as root, whatever user the panel runs as inside its container.

`:ro` on the mount does not change this. A read-only bind mount stops the container from replacing
or deleting the socket file. It does not stop the container from connecting to the socket and
sending API requests, and every request, `POST /containers/create` included, goes through that
connection.

The same applies to the web console and to a shell in a container: the console runs in the panel's
container, next to the socket, so an owner who turns it on gives whoever may open it a root shell on
the host.

## Who reaches it through the panel

| Path | Default | What limits it |
| --- | --- | --- |
| The web interface | on | Sign-in, roles checked on every Socket.IO event and nested agent call; a viewer has no files, secrets, logs or terminals |
| The web console | off | An owner turns it on with a password and decides whether operators may open it |
| Secrets | on | `0600` files; revealing, saving and deleting require the password again |
| MCP | off | Individual revocable keys scoped to servers and stacks; writes go through prepare and apply with a deadline and a re-check of the caller's rights |
| Containers outside the stacks | off | An owner allows operators to start, stop and restart them, per server and with a password; the server inspects the container again before the command and refuses stacks' containers and the panel's own. No removal, no `exec` |
| The panel's own container | - | Recognised by its container id, never by name; down, delete, start, restart, deploy and update are refused on it |
| Remote agents | none | Each agent is a panel of its own with its own socket; a nested call carries the caller's role |
| Updating the panel | owner | The password, a signed release and a helper container with the data directory mounted read-only |

No Socket.IO event lets the browser run an arbitrary git, shell or Docker command. Stack file
names are safe relative paths only.

## What the browser is protected from

Every answer carries a Content Security Policy that allows scripts from the panel only, so injected
markup cannot run code, and refuses framing, so another page cannot trick an owner into clicking
through a deployment. `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
`Referrer-Policy: same-origin` go with it. Styles keep `'unsafe-inline'`: the terminal writes
`<style>` elements and offers no nonce.

## Reducing the risk

- Do not publish the panel to the internet directly. Put it behind a reverse proxy with HTTPS, see
  [Configuration](configuration.md#behind-a-reverse-proxy), or reach it through a VPN.
- Turn on two-factor authentication for owners, see [Authentication](authentication.md).
- Give the operator role only to people you would give root, and keep the console off unless you
  need it.
- A Docker socket proxy that filters the API does not fit: deploying a stack needs creating
  containers, networks and volumes and running `exec`, which is most of the dangerous surface.
- Rootless Docker limits the damage to the account that runs the daemon. The panel only needs the
  socket mounted at `/var/run/docker.sock` and the stack paths identical inside and outside, but this
  setup is not covered by the project's tests.
- Report a vulnerability through the [security policy](../.github/SECURITY.md), not a public issue.
