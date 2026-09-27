# Installation

Dockge2 runs as one container next to your stacks. A release is installed by a signed host
updater, and the same updater later updates the panel and rolls it back. Nothing is built on the
server.

## Requirements

- Linux on amd64 or arm64, with Docker Engine 24+ and Docker Compose 2.20+ on the same host.
  Remote Docker contexts and Podman are not supported by the updater.
- `bash`, `curl`, `sha256sum` and the right to manage Docker. Run the installer as root when the
  existing data is root-owned. Node, Git and a source checkout are not needed.
- About 200 MB of RAM for the panel, plus your stacks. Every update keeps the previous image and a
  copy of the panel data, so reserve disk space for two images, one data snapshot and the recovery
  tools.

## Install

```bash
curl -fsSL https://github.com/mazixs/dockge2/releases/latest/download/install.sh | sudo bash
```

The installer checks the host and verifies the release, then shows the plan and asks whether to
install it. Nothing is written and no image is pulled before you answer `y`. At the end it prints
the address of the panel and the setup code for the owner account, see [first sign-in](#first-sign-in).

Options go after `bash -s --`, for example another port:

```bash
curl -fsSL https://github.com/mazixs/dockge2/releases/latest/download/install.sh | sudo bash -s -- --port 8080
```

Bash reads the whole script before it runs any of it, so a download cut short runs nothing. The
question is asked on the terminal, not read from the pipe. Without a terminal, as in a provisioning
script, the installer stops before any change: review the plan with `--dry-run`, then run the same
command with `--yes`.

### Reading the installer first

To read the script before it runs, save it, read it, then run the saved copy with the same options:

```bash
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://github.com/mazixs/dockge2/releases/latest/download/install.sh -o /tmp/dockge2-install.sh
less /tmp/dockge2-install.sh
```

```bash
sudo bash /tmp/dockge2-install.sh
```

### What is verified

The installer downloads a pinned Cosign binary, checks its SHA-256, and verifies that the host
updater was signed by this repository's release workflow for the selected tag. The updater then
verifies the signed release descriptor and pulls the image by digest. A bad signature, a missing
asset or an unreachable registry stops the installation: it never falls back to building the
source. The reviewed installer and GitHub HTTPS are the initial trust root, see
[release trust](self-updates.md#release-contract-and-trust).

The verified installer exists from release `0.0.10`. To move an older installation to it, see
[upgrading an older installation](updating.md#upgrading-an-older-installation).

## What the installer prints

The output comes in sections, one line per check with its result in a column: `ok`, `missing`,
`failed` or `warning`. A problem goes to stderr with its cause and a hint under it, and the last
line says where the installation stands. Colour is used in a terminal only; `NO_COLOR` turns it
off.

1. **Host**: Linux on amd64 or arm64 and the `curl`, `sha256sum` and `docker` commands. Every unmet
   requirement is listed at once, before anything is downloaded.
2. **Updater**: the pinned Cosign binary and its checksum, then the signature of the updater.
3. **Docker**: a local daemon and the Engine and Compose versions. Docker is not run before the
   updater is verified; until then the installer only checks that the command exists.
4. **Release**: the signed descriptor and the files it lists, then the Docker versions this release
   needs.
5. **Plan**: what will be installed, where, and on which port, then the question. `--dry-run`
   stops before it, and `n` cancels with nothing changed.
6. Each step of the installation, then **Done** with the addresses of the host, the setup code and
   the command for later updates. The addresses are the host's own: behind NAT, use its public
   one.

A host without Docker stops in the first section:

```text
Dockge2 installer

Host
  ok       Linux amd64
  ok       curl
  ok       sha256sum
  missing  docker
           Install Docker Engine 24 or newer with the Compose plugin, then run this again:
           https://docs.docker.com/engine/install/

Stopped: 1 requirement is not met.
Nothing was downloaded or changed.
```

Updates, rollbacks and `--resume` print the same sections. When an update fails after the panel
was stopped, the failed step comes first, then a **Recovery** section with the steps that brought the
previous version back.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--dir DIR` | `/opt/dockge2` | Installation directory: `.env` and the updater state |
| `--version X.Y.Z` | the latest stable release | Install an exact release, a prerelease included |
| `--port PORT` | `5001` | Port of the web interface, the same on the host and in the container |
| `--data-dir DIR` | `<dir>/data` | Panel database and settings; an absolute path, new or empty |
| `--stacks-dir DIR` | `/opt/stacks` | Directory of the stacks; an absolute path |
| `--compose-override FILE` | none | Extra Compose file for the panel service; absolute path, repeatable |
| `--dry-run` | | Show the plan and stop |
| `--yes` | | Accept the plan without asking |

For example, with explicit paths and port:

```bash
curl -fsSL https://github.com/mazixs/dockge2/releases/latest/download/install.sh | sudo bash -s -- \
  --port 8080 --data-dir /var/lib/dockge2/data --stacks-dir /srv/stacks
```

`--help` lists every option, including the ones used for updates and recovery:

```bash
curl -fsSL https://github.com/mazixs/dockge2/releases/latest/download/install.sh | bash -s -- --help
```

## What gets installed

| Where | What |
| --- | --- |
| `<dir>/.env` | Settings of the panel container, permissions `0600`, see [configuration](configuration.md) |
| `<dir>/.dockge2/` | Updater state, verified release files, data snapshots and the `update` launcher |
| `<data-dir>` | SQLite database, settings and the one-use `bootstrap-token` |
| `<stacks-dir>` | Your stacks, one directory each |

In Docker this is one container, `dockge2-dockge-1`, in the Compose project `dockge2`, running the
image `ghcr.io/mazixs/dockge2` pinned by digest. It restarts unless stopped, and its log is capped
at three files of 10 MB.

The installer does not open firewall ports and does not set up HTTPS.

## First sign-in

The first visit asks for a setup code, a username, an email and a password. The **Done** section of
the installer shows the code when it runs in a terminal. Captured output, such as a provisioning
log, gets the command that reads it from the data directory instead:

```bash
sudo cat /opt/dockge2/data/bootstrap-token
```

The file is deleted as soon as the owner exists. Keep the code out of chats, logs and
repositories. The owner then creates the other accounts under Settings -> Users; public signup
is always off. See [authentication](authentication.md) for roles, two-factor authentication and
password recovery.

Put a public instance behind a reverse proxy with HTTPS, see
[configuration](configuration.md#behind-a-reverse-proxy).

## Paths and permissions

- The stacks directory has the same absolute path on the host and in the container. `docker compose`
  runs inside the panel, but the Docker daemon on the host resolves the paths of your bind mounts,
  so `./config` in a stack has to mean the same directory to both.
- Keep the panel data on a local filesystem, apart from the stacks directory and from `.dockge2`.
  Named volumes and symlinked data paths are refused.
- Files the panel creates in stacks belong to root. Set both `PUID` and `PGID` in `.env` to create
  them for another user.

## SSH keys, registry logins and certificates

Some features need a file from the host inside the panel container: an SSH key for private Git
repositories, a `docker login` for private registries, TLS files for HTTPS without a proxy. The
updater never changes the mounts of an existing installation, so decide on them when you install.
Put them in an override file:

```yaml
# /opt/dockge2/overrides/mounts.yml
services:
  dockge:
    volumes:
      # SSH key without a passphrase and known_hosts, for private Git repositories
      - /root/.ssh:/root/.ssh:ro
      # docker login, for private registries
      - /root/.docker:/root/.docker
      # TLS files named in DOCKGE_SSL_*
      - /opt/dockge2/certs:/app/certs:ro
```

and name it on installation:

```bash
curl -fsSL https://github.com/mazixs/dockge2/releases/latest/download/install.sh | sudo bash -s -- \
  --compose-override /opt/dockge2/overrides/mounts.yml
```

The updater records the override and reads it again on every update, so leave the file where it is.
Implicit `COMPOSE_FILE` and `compose.override.yaml` discovery are not used.

## Uninstall

There is no uninstall command, and removing the panel does not touch your stacks: each one is its
own Compose project and keeps running.

1. Check that no update is in progress. The `phase` must be `success`, `recovered` or
   `failed-before-cutover`:

   ```bash
   sudo /opt/dockge2/.dockge2/update --status
   ```

2. If you may want the accounts, settings and availability history later, stop the panel and copy
   its data:

   ```bash
   sudo docker compose -p dockge2 stop
   sudo cp -a /opt/dockge2/data /root/dockge2-data-backup
   ```

3. Remove the container and its network:

   ```bash
   sudo docker compose -p dockge2 down
   ```

4. Remove the images: first the recovery tags the updater keeps, then the panel images. A fresh
   installation has no recovery tags, and then the first command does nothing:

   ```bash
   sudo docker image ls dockge2-recovery --format '{{.Repository}}:{{.Tag}}' | xargs -r sudo docker image rm
   sudo docker image ls -q ghcr.io/mazixs/dockge2 | xargs -r sudo docker image rm
   ```

5. Delete the installation directory. With the default layout it also holds the panel data. A data
   directory chosen with `--data-dir` is removed separately, along with any `*.dockge-failed-*`
   copies next to it:

   ```bash
   sudo rm -rf /opt/dockge2
   ```

Your stacks stay in `/opt/stacks`: manage them with `docker compose`, or delete them yourself. The
updater also leaves empty lock files `/tmp/dockge2-update-*.lock`, which are harmless.
