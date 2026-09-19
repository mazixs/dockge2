<div align="center" width="100%">
    <img src="./frontend/public/icon.svg" width="128" alt="" />
</div>

# Dockge2

A self-hosted manager for `compose.yaml` stacks: your compose files stay files on your disk,
and the panel only reads and runs them.

[![GitHub last commit](https://img.shields.io/github/last-commit/mazixs/dockge2/main?logo=github)](https://github.com/mazixs/dockge2/commits/main/)
[![License](https://img.shields.io/github/license/mazixs/dockge2)](./LICENSE)

Dockge2 is a fork of [Dockge](https://github.com/louislam/dockge). It is not a drop-in replacement:
authentication, access levels, stack status, availability, MCP access and the whole interface have
been rewritten. Do not report issues of this fork upstream.

## Features

- Manage `compose.yaml` files: create, edit, start, stop, restart, delete, update images.
- Interactive editor for `compose.yaml`, and conversion of a `docker run ...` command into one.
- Interactive web terminal per container, and a read-only journal per stack.
- Multiple agents: stacks from several Docker hosts in one interface.
- Accounts with three levels (owner, operator, viewer), two-factor authentication, sessions in an
  `httpOnly` cookie.
- Stack secrets stored as files with `0600` permissions; only metadata ever leaves the server.
- Availability measured from recorded status changes, not guessed from the current state.
- Opt-in MCP access for AI clients, with expiring keys, explicit scopes and optional owner approval.
- File based structure: Dockge2 does not kidnap your compose files, you can keep using
  `docker compose` on the same directories.

## Requirements

- Linux on `amd64`, `arm64` or `armv7`. Debian/Raspbian Bullseye or newer, Ubuntu, Fedora, CentOS,
  ArchLinux. Windows is not supported.
- [Docker](https://docs.docker.com/engine/install/) 20+ with the Compose V2 plugin, or Podman with
  `podman-docker`. The installer offers to install Docker when it is missing.
- `git` and `curl`. Nothing else: the image builds its own frontend, so the server needs no Node.

## Install

On a fresh server, one script does the whole thing - it checks what is missing, asks for the port
and the directories, shows them for review, builds the image, starts the panel and prints the
address and the one-use setup code:

```bash
curl -fsSL https://raw.githubusercontent.com/mazixs/dockge2/main/install.sh -o install.sh
less install.sh          # it runs as root, so read it first
bash install.sh
```

Answer nothing and take every default with `bash install.sh --yes`, or say it all upfront:

```bash
bash install.sh --yes --port 8080 --stacks-dir /srv/stacks --dir /opt/dockge2
```

| Option | Default | What it is |
|---|---|---|
| `--port` | `5001` | The port the panel answers on. The installer refuses a port that is already taken and offers another. |
| `--stacks-dir` | `/opt/stacks` | Where your stacks live. Absolute path only, see the note below. |
| `--dir` | `/opt/dockge2` | Where this repository is checked out. |
| `--data-dir` | `<install dir>/data` | SQLite database, settings and secrets. |
| `--branch` | `main` | Branch to install from. On an update it is the branch the checkout is already on. |
| `--update` | - | Rebuild the installation the script lives in, without asking for the directories again. |
| `--yes` | - | Take the defaults and ask nothing. Required when there is no terminal at all, such as in cron. |

Before anything is written, the answers are shown as a numbered list: Enter accepts them, a number
asks that one again, `q` leaves the machine as it was. Until that point nothing has changed.

The script writes only inside those three directories, never stops or changes containers it did not
create, and reads every answer it already has from the existing `.env` when it runs again. An option
given on the command line wins over that `.env` and is written into it, so `--port 8080` on a second
run really moves the panel instead of printing an address that answers nothing. Sudo is used only
where it is actually needed - not at all when you are in the `docker` group and the directories are
yours.

Nothing is decided silently. Without a terminal - in cron, or in a pipeline - the installer stops
and asks for `--yes` rather than agreeing to install Docker or to rebuild a running panel on your
behalf. An interrupted first install removes the half-written directory instead of leaving one the
next run would refuse. A failed build or a panel that never became healthy prints the container
state, the last log lines, and the two commands that put back the image and the commit that were
running before - the previous image is tagged `dockge2:rollback-<date>` before the rebuild starts,
and only the newest such tag is kept, so updates do not pile images up on a small disk. Local
changes in the checkout are never reset, stashed or overwritten: the update only fast-forwards, and
says so when it cannot. After a rollback the checkout stands on a commit rather than a branch, and
the next `--update` says so and stops until you are back on the branch (`git checkout main`).

When it finishes, open the printed address and the first visit asks for the setup code together
with the owner account - see [Sign in](#sign-in). On a public server, put it behind a reverse proxy
with HTTPS or reach it over an SSH tunnel first; the installer warns when `ufw` is on and the port
is closed, and it does not open it for you.

### By hand

The script does nothing magic, and the same thing without it is:

```bash
sudo mkdir -p /opt/stacks
git clone https://github.com/mazixs/dockge2.git /opt/dockge2
cd /opt/dockge2
cp .env.example .env     # ports, paths, proxy settings - read the comments
docker compose -f docker-compose.yml up -d --build --wait
```

`docker-compose.yml` is the production configuration and it is documented line by line inside the
file. Three settings deserve attention before the first start:

- `DOCKGE_STACKS_DIR` (default `/opt/stacks`): an absolute path, and the path on the host and inside
  the container must be identical. The panel runs `docker compose` inside the container, but the
  daemon that executes it lives on the host and will be given exactly that path.
  Correct: `/my-stacks:/my-stacks`. Wrong: `/docker:/my-stacks`.
- `DOCKGE_DATA_DIR` (default `./data`): SQLite database, settings and secrets. Keep it on a local
  disk - SQLite and a network filesystem do not go together - and outside the Git checkout in
  production, for example `/var/lib/dockge2/data`.
- `PUID` and `PGID` set the owner of the stack files the panel creates. Both must be set, otherwise
  the files belong to `root`.

A proxy in front of the panel needs two more variables - see
[behind a reverse proxy](#behind-a-reverse-proxy). Updating means rebuilding the image from the
checkout, and the previous image stays on the host for a rollback - see
[how to update](#how-to-update).

## Development

Local development runs in one container, so the host needs only Docker and a `.env`:

```bash
cp .env.example .env   # once
./local.sh             # ./local.sh -d to keep it in the background
```

The script recreates the `dockge2-local` project from `docker-compose.local.yml` and runs
`npm run dev` inside it: Vite on http://localhost:5000, the backend on http://localhost:5001, both
reloading on change. Dependencies live in their own `node_modules` volume, and the stacks directory
defaults to `/tmp/dockge2-stacks` (`DOCKGE_LOCAL_STACKS_DIR` changes it), so development never
touches your real `/opt/stacks`.

Stop it with `docker compose -p dockge2-local -f docker-compose.local.yml down`.

`npm run check` - lint, strict types and unit tests - is what a change has to pass before it is
submitted; the browser tests are `npm run test:e2e`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Sign in

The first visit asks for a setup code, username, email and password. Read the one-use
code from `bootstrap-token` in the Dockge data directory (permissions `0600`), or set
`DOCKGE_BOOTSTRAP_TOKEN` to a secret of at least 32 characters. Public signup is always
disabled. After setup, the owner issues accounts under Settings -> Users and assigns
owner, operator or viewer permissions. Existing owner accounts and sessions survive
an upgrade; email login remains supported.

Sessions use an `httpOnly` cookie. Two-factor authentication (TOTP plus backup codes)
is available under Settings -> Security. Suspending an account, changing its role,
resetting its password or deleting it revokes its sessions and open connections.
Viewers receive status and stability data without raw files, secrets, logs or terminals.

Lost the owner password? Another owner can reset it. For local recovery,
`npm run reset-account` (or `docker compose exec dockge npm run reset-account`)
asks before removing **all accounts and their sessions**. Stacks, settings and agents
remain. Restart Dockge and read the new setup code to create a replacement owner.
See [authentication and proxy configuration](docs/authentication.md) for details.

Dockge2 also provides opt-in MCP access for AI clients, with individual expiring keys,
explicit server/stack scopes, observer and operator roles, and optional owner approval.
See [MCP access and verified client compatibility](docs/mcp.md). MCP is disabled by default.

### A stack from a private repository

Git is part of the product - the panel clones a stack, tells you how far behind its branch it is
and applies an update - and the image carries `git` and `ssh` for that. How it authenticates is
deliberately narrow:

- No prompt is ever shown (`GIT_TERMINAL_PROMPT=0`), credential helpers are disabled and the global
  Git configuration is ignored. A command that would ask for a password fails instead of hanging.
- A token inside the repository URL is rejected outright, so a secret cannot end up in the
  configuration, in a list or in a log.
- That leaves one way in: an SSH key, mounted into the container, without a passphrase, plus a
  `known_hosts` entry for the host. Uncomment the `/root/.ssh` line in `docker-compose.yml`.

A private repository without that key does not half work: the clone fails with the authentication
error from Git, and the panel shows it as it came. Nothing in the panel needs the `gh` CLI - it
speaks to Git directly, never to the GitHub API.

### Behind a reverse proxy

Dockge accepts requests whose origin matches the address the browser asked for, so a LAN
address, a container name and a domain all work without configuration. Two variables
matter when a proxy sits in front:

| Variable | What it does |
|---|---|
| `DOCKGE_TRUST_PROXY=true` | Believe `X-Forwarded-For`/`X-Forwarded-Host`, so rate limits count per real client and the proxied host counts as its own origin. Only set it when a proxy really is in front, otherwise a caller writes those headers itself. |
| `DOCKGE_SECURE_COOKIES=true` | Mark the session cookie `Secure` even though Dockge itself speaks plain HTTP behind the proxy. |
| `DOCKGE_TRUSTED_ORIGINS` | Comma separated extra origins, for a UI served from another host. |
| `DOCKGE_PUBLIC_URL` | Public HTTP(S) origin without a path. HTTPS automatically enables Secure cookies. |
| `DOCKGE_BOOTSTRAP_TOKEN` | Optional one-use setup code, at least 32 characters. Otherwise stored in the local `bootstrap-token` file. |
| `DOCKGE_AUTH_SECRET` | Signs session cookies. Generated and stored in the database on first start, so set it only to share one secret across replicas. |

The socket carries everything the panel does - status, logs, terminals - and its handshake is
checked against the same origins. A proxy that rewrites `Host` to an internal name (the usual
`proxy_set_header Host $host;`) therefore has to pass `X-Forwarded-Host` and `X-Forwarded-Proto`
with `DOCKGE_TRUST_PROXY=true`, or the public address has to be named in `DOCKGE_PUBLIC_URL`.
Without one of the two the page loads and then sits there connecting. A worked nginx configuration:

```nginx
location / {
    proxy_pass http://127.0.0.1:5001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $http_host;   # with the port, when the address has one
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

`DOCKGE_WS_ORIGIN_CHECK=bypass` exists for a setup none of this fits. It switches the check off
rather than configuring it, so it is the last resort, not the first.

## How to Update

The deployment is a Git checkout and the image is built from it, so updating means rebuilding.
The installer does exactly that and needs nothing else on the host:

```bash
cd /opt/dockge2
./install.sh --update
```

`--update` works on the checkout the script itself lives in, so an installation made with `--dir`
updates from its own directory without naming it again.

The same sequence is also available as a bundled command, which prints what it will do first. It is
fixed and non-destructive - `git pull --ff-only`, `docker compose config --quiet`, then
`docker compose up -d --build --wait --wait-timeout 180` - the health check starts after 60
seconds and repeats every 60, so a minute is not enough:

```bash
cd /opt/dockge2
npm run update-docker -- --dry-run   # prints the commands and changes nothing
npm run update-docker
```

It fast-forwards `origin/main` by default; a deployment that tracks another branch names it with
`npm run update-docker -- --branch=release/2.0`.

### Rollback

`DOCKGE_IMAGE` is one fixed tag, and `docker compose up --build` re-points it at the image it has
just built, so the image you are running right now loses its only name during an update. Give it a
name of its own first, and then a rollback needs no rebuild:

```bash
cd /opt/dockge2
docker image tag dockge2:latest "dockge2:$(git describe --tags --always)"   # before updating
npm run update-docker
```

Going back to it:

```bash
docker image ls dockge2          # the tag you came from
cd /opt/dockge2
git checkout <previous tag>
DOCKGE_IMAGE=dockge2:<previous tag> docker compose -f docker-compose.yml up -d --wait
```

The data directory is not touched by any of this. A migration that changed the database schema is the
one case where a rollback needs a database copy taken before the update.

### Updating one stack from Git

A stack directory that is a Git checkout can be updated the same way, with the compose file and the
env files named explicitly and the configuration validated before anything starts:

```bash
npm run deploy-stack -- --stack=my-stack --dry-run
npm run deploy-stack -- --stack=my-stack --file=compose.yaml --env-file=.env --env-file=.env.product
```

The command stops when the stack directory has local changes, never runs `git reset` or `git clean`,
and `--skip-git` deploys a stack that is not a checkout. As above, this is a local administrative
command, not a browser action.

- `docker compose up` already recreates the container when the image or configuration changed, and it
  keeps attached volumes and bind mounts.
- `--force-recreate` (`npm run update-docker -- --force-recreate`) forces recreation without deleting
  attached data.
- `docker compose config --quiet` validates the configuration before anything is restarted, and
  `--wait --wait-timeout 180` fails instead of leaving the update in an undefined state.
- The command refuses to run with a dirty working copy, and it never runs `docker compose down -v`,
  `docker volume prune`, `git reset --hard` or `git clean -fdx`.
- Keep `./data` outside the Git checkout in production, for example `/var/lib/dockge2/data`, so that even
  a mistaken `git clean` cannot touch the database.
- The image is built from this checkout, so `git pull` alone changes nothing inside the running
  container until the image is rebuilt - which is exactly what `npm run update-docker` does.
- Updating is a local, administrative action. There is intentionally no Socket.IO event for it, because
  that would give the browser a remote `git pull` plus Docker control.

## Community and contribution

- Bug reports: https://github.com/mazixs/dockge2/issues
- Questions and discussions: https://github.com/mazixs/dockge2/discussions
- Translation: see [the translation guide](frontend/src/lang/README.md). The switcher offers only
  languages that are translated in full - currently English and Russian; the other catalogues are in
  `frontend/src/lang/` waiting to be finished, and a complete one joins the menu automatically
- Pull requests: read [CONTRIBUTING.md](CONTRIBUTING.md) first, not every kind of change is accepted
- Security: see [SECURITY.md](SECURITY.md), never report a vulnerability in a public issue

Documentation lives in `docs/`: [authentication](docs/authentication.md), [MCP access](docs/mcp.md),
[design system](docs/design-system.md) and the
[master plan](docs/plans/2026-08-26-dockge2-master-plan.md), which records what was decided and why.

## FAQ

#### Can I manage a single container without `compose.yaml`?

No. Dockge2 uses `compose.yaml` for everything on purpose: a stack is a directory with a compose
file, and that is what makes the files yours rather than the panel's. For a single container, use
the Docker CLI.

#### Can I manage existing stacks?

Yes, if the compose file is inside the stacks directory:

1. Stop your stack.
2. Move its compose file to `/opt/stacks/<stackName>/compose.yaml`.
3. In Dockge2, use "Scan stacks folder" in the top-right menu.
4. The stack appears in the list.

#### Does Dockge2 phone home?

No. The update check is off by default, and when you turn it on it asks the GitHub releases of this
repository and nothing else.

#### How is it different from upstream Dockge?

Accounts and access levels, two-factor authentication, stack secrets, availability measured from
recorded status changes, MCP access for AI clients, and an interface rewritten screen by screen.
Version numbering starts at 2.0.0 and does not follow upstream.

## Origin and license

Dockge2 is a fork of [Dockge](https://github.com/louislam/dockge) by Louis Lam, MIT licensed.
This fork is also MIT licensed and keeps the original copyright notice; see [LICENSE](LICENSE).
`compose.yaml` is also known as `docker-compose.yml`; both are
[Compose V2](https://docs.docker.com/compose/migrate/).
