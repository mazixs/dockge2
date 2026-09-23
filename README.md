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

- Linux amd64 or arm64, Docker Engine 24+ and Docker Compose 2.20+ on the same host.
  Remote Docker contexts and Podman are not supported by the transactional updater.
- Bash, curl, sha256sum and permission to manage Docker and read/write the panel data directory.
  Run as root when the existing data is root-owned. No Node, Git or local build is required.
- About 200 MB RAM for the panel, plus your stacks. Updates download a published image.
  Reserve disk space for the new image, the previous image, a complete data snapshot and recovery
  tools. Building development sources separately needs about 1 GB RAM.

## Install

Download the bootstrap **from a release**, review it, then run it on the Docker host:

```bash
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://github.com/mazixs/dockge2/releases/latest/download/install.sh -o /tmp/dockge2-install.sh
less /tmp/dockge2-install.sh
sudo bash /tmp/dockge2-install.sh --dir /opt/dockge2 --dry-run
sudo bash /tmp/dockge2-install.sh --dir /opt/dockge2 --yes
```

The verified installer is supported from `0.0.10`, with `release.json`, signatures and host updater
binaries attached to the release. Older releases, including `0.0.8`, do not have this contract.
For an existing installation, follow [the migration instructions](docs/self-updates.md#legacy-import).

The bootstrap downloads a pinned Cosign verifier, checks its embedded SHA-256, then verifies the
updater's signature for this repository's tagged release workflow. The updater verifies a signed
release descriptor before using its Compose file or other assets. The image is installed by digest.
An unavailable registry, bad signature or missing asset stops installation; it never builds `main`.
The reviewed bootstrap and GitHub HTTPS are the initial trust root; see
[release trust and recovery](docs/self-updates.md).

Defaults are port `5001`, `/opt/stacks`, and `<installation>/data`. To choose them explicitly:

```bash
sudo bash /tmp/dockge2-install.sh --dir /opt/dockge2 --port 8080 \
  --data-dir /var/lib/dockge2/data --stacks-dir /srv/stacks --yes
```

Open `http://SERVER:PORT`. Read the one-use setup code from `bootstrap-token` in the selected data
directory; do not publish that file. Put public installations behind
[a reverse proxy](#behind-a-reverse-proxy). The installer does not open firewall ports.

The stack directory must have the same absolute path on the host and in the container. Keep the
panel data on a local filesystem, separate from the stack directory and `.dockge2` updater state.
Existing bind mounts, `.env` bytes and Git checkout are preserved during updates. Put custom Compose
settings in explicitly named `--compose-override /absolute/file.yml` files. Implicit `COMPOSE_FILE`
and `compose.override.yaml` discovery are not used. Mount changes require a separate migration.
`PUID` and `PGID` must both be set when stack files should be created for a different owner.

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

Settings -> About checks only when the owner asks or enables automatic checks. It lists complete
releases, separates failed/stale checks from current results, and names an exact version in the
installation command. Including prereleases in discovery does not change your installation channel.

After installing with the verified updater:

```bash
cd /opt/dockge2
sudo .dockge2/update --dry-run
sudo .dockge2/update --yes
# Select an exact release, including a prerelease:
sudo .dockge2/update --version X.Y.Z-rc.1 --yes
```

`latest` resolves once to the stable release. An explicit version tag stays selected; a configured
mirror is retained and must serve the signed digest. `--image REPOSITORY:TAG` explicitly changes
that choice. An unknown custom/local image requires an explicit choice; `--yes` never authorizes a
source switch. The desired channel and installed digest are recorded separately. After import, change the channel
with `--image`; editing `DOCKGE_IMAGE` in the preserved `.env` does not override that record.

The current versions of `bash install.sh --update --dir /opt/dockge2` and `npm run update-docker -- --dry-run` call this
same engine. npm is optional and does not require installing TypeScript dependencies to update.
Updates never fetch, reset or switch the user's Git checkout. A broken or newer `main` cannot change
the selected release's image, Compose file or updater.

Downloads, signature verification and configuration validation precede downtime. The updater locks
the Docker project, retains the actual running image, stops only the panel, copies and verifies its
data, then starts the selected digest. Compose waits up to 180 seconds; readiness checks database
and auth initialization, the reported application version and a further 10 seconds of stable runtime.
Managed stack containers are not restarted. A no-op preserves the previous distinct deployment.

### Migrating an older installation

**Do not run the old checkout's installer or npm updater as the migration step. After migration, continue using `.dockge2/update`; the preserved old checkout
still contains its old entry points.** Download and review
the new released bootstrap using the installation instructions, then run:

```bash
sudo bash /tmp/dockge2-install.sh --update --dir /opt/dockge2 --version X.Y.Z --dry-run
sudo bash /tmp/dockge2-install.sh --update --dir /opt/dockge2 --version X.Y.Z --yes
```

Replace `X.Y.Z` with the published release version. The initial import contract covers `0.0.8` with
its original vendor Compose file and a running panel. A dirty checkout is allowed. The updater
checks the running version, mounts and environment, and refuses an ambiguous identity or edited
vendor file. Preserve local Compose edits in an explicit override after comparing them with the
original released base; never discard edits to satisfy the importer. `--compose-file` selects a
matching legacy base under a different filename; `--project` identifies a custom Compose project.
Local-build installations must explicitly choose `--image ghcr.io/mazixs/dockge2:latest` to migrate
to published releases. Unknown legacy versions stop before cutover.

For a `0.0.7` installation, use the verified [two-step migration through the released `0.0.8`
image](docs/self-updates.md#from-007-to-0010). Direct `0.0.7` import into `0.0.10` is refused.

### Rollback and interruptions

```bash
cd /opt/dockge2
sudo .dockge2/update --rollback --dry-run
sudo .dockge2/update --rollback --yes
# Only when panel data restoration is intended:
sudo .dockge2/update --rollback --restore-data --yes
```

Rollback uses the recorded local image ID and exact previous configuration, without a network pull
or a branch checkout. If the schema contract changed, `--restore-data` is required: it restores the
stopped-data snapshot and discards subsequent panel writes from the active database. The newer data
is retained beside it as `*.dockge-failed-<operation>`. Stack files and stack volumes are not restored.
Schema identity conservatively includes application migrations, auth code and the dependency lock.

Before the target has started, or with an unchanged schema, a failed update attempts to restart and
verify the previous panel. Other failures remain `recovery-required`, with the failed target stopped.
After a crash, inspect `.dockge2/update --status`; a new update cannot overwrite an unfinished one.
Use `--resume` to retry a recorded target after fixing an external problem, or `--rollback` to recover.
The installed recovery tool survives application startup failure. A failed first installation has
no previous deployment; preserve its data and journal for diagnosis instead of deleting them blindly.

Snapshots and retained images are not automatically pruned. Review disk use and keep the currently
recorded recovery set; never run a global prune as part of updating. See
[the detailed recovery procedure](docs/self-updates.md).

### Explicit development deployment

Development builds are separate from release updates and require Git and enough memory to build:

```bash
sudo .dockge2/update --development --ref YOUR_REF --yes
```

This fetches the named ref into temporary staging and records its resolved commit. It never falls
back to a build because a release download failed. An existing unknown local deployment must first
be imported through a supported release. For day-to-day source development use `./local.sh`.

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

Updating is a local administrative action. The browser does not expose a self-update shell command.

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
Version numbering is this fork's own and does not follow upstream: it starts at 0.0.1.

## Origin and license

Dockge2 is a fork of [Dockge](https://github.com/louislam/dockge) by Louis Lam, MIT licensed.
This fork is also MIT licensed and keeps the original copyright notice; see [LICENSE](LICENSE).
`compose.yaml` is also known as `docker-compose.yml`; both are
[Compose V2](https://docs.docker.com/compose/migrate/).
