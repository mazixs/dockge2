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

- [Docker](https://docs.docker.com/engine/install/) 20+ with the Compose V2 plugin, or Podman with
  `podman-docker`.
- Linux on `amd64`, `arm64` or `armv7`. Debian/Raspbian Bullseye or newer, Ubuntu, Fedora, CentOS,
  ArchLinux. Windows is not supported.
- [Node.js](https://nodejs.org/) 22.23.2 or 24.19.0, to build the image from this repository.

## How to install

There is no published image yet, so the image is built from this repository.

```bash
# Where the panel lives and where your stacks live
sudo mkdir -p /opt/stacks
git clone https://github.com/mazixs/dockge2.git /opt/dockge2
cd /opt/dockge2

cp .env.example .env     # ports, paths, proxy settings - read the comments
npm install
npm run build:frontend   # the image copies the ready frontend-dist directory

docker compose -f docker-compose.yml up -d --build
```

The panel is now on http://localhost:5001 and asks for a setup code (see [Sign in](#sign-in)).

`docker-compose.yml` is the production configuration and it is documented line by line inside the
file. Two settings deserve attention before the first start:

- `DOCKGE_STACKS_DIR` (default `/opt/stacks`): an absolute path, and the path on the host and inside
  the container must be identical. The panel runs `docker compose` inside the container, but the
  daemon that executes it lives on the host and will be given exactly that path.
  Correct: `/my-stacks:/my-stacks`. Wrong: `/docker:/my-stacks`.
- `DOCKGE_DATA_DIR` (default `./data`): SQLite database, settings and secrets. Keep it on a local
  disk - SQLite and a network filesystem do not go together - and outside the Git checkout in
  production, for example `/var/lib/dockge2/data`.
- `PUID` and `PGID` set the owner of the stack files the panel creates. Both must be set, otherwise
  the files belong to `root`.

## Запуск локально

Локальная разработка поднимается одной командой из корня репозитория:

```bash
cp .env.example .env   # достаточно один раз
./local.sh             # ./local.sh -d, если нужен фон
```

Скрипт пересоздает контейнеры проекта `dockge2-local` по `docker-compose.local.yml`
и запускает внутри `npm run dev`: Vite на http://localhost:5000 и бэкенд на
http://localhost:5001, оба с автоперезапуском. Зависимости ставятся в отдельный
том `node_modules`, каталог стеков по умолчанию - `/tmp/dockge2-stacks`
(меняется через `DOCKGE_LOCAL_STACKS_DIR`).

Остановить: `docker compose -p dockge2-local -f docker-compose.local.yml down`.

Production-конфигурация лежит в `docker-compose.yml`: образ собирается из этого
репозитория, поэтому сначала `npm run build:frontend`.

```bash
npm run build:frontend
docker compose -f docker-compose.yml up -d --build
```

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

## How to Update

The deployment is a Git checkout and the image is built from it, so updating means rebuilding.
The bundled command runs a fixed, non-destructive sequence - `git pull --ff-only`, `npm ci`,
`npm run build:frontend`, `docker compose config --quiet`, then
`docker compose up -d --build --wait --wait-timeout 60`:

```bash
cd /opt/dockge2
npm run update-docker -- --dry-run   # prints the commands and changes nothing
npm run update-docker
```

It fast-forwards `origin/main` by default; a deployment that tracks another branch names it with
`npm run update-docker -- --branch=release/2.0`.

### Rollback

The previous image is still on the host under its own tag, so a rollback does not need a rebuild:

```bash
docker image ls dockge2          # find the tag you came from
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
- `--pull always` makes sure a new image is actually checked, and `--wait --wait-timeout 60` fails
  instead of leaving the update in an undefined state.
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
- Translation: see [the translation guide](frontend/src/lang/README.md)
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
