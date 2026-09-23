# Updating

The panel is updated on the host, by the updater that the installer placed in
`<installation>/.dockge2/update`. The browser only tells you that a release exists: Settings ->
About checks when the owner asks, or on a schedule once automatic checks are enabled, and shows the
command for the exact version.

Updating the panel never touches your stacks: their images are updated from the stack page, and
their containers are not restarted when the panel is.

## Update

```bash
sudo /opt/dockge2/.dockge2/update --dry-run
sudo /opt/dockge2/.dockge2/update --yes
```

`--dry-run` verifies the release and shows the current and target versions, the configuration
fields that change and whether a later rollback would need the data snapshot, then stops. `--yes`
performs the update. Without `--version` the updater follows the recorded channel, by default the
newest stable release. To pick a release, a prerelease included:

```bash
sudo /opt/dockge2/.dockge2/update --version X.Y.Z --dry-run
sudo /opt/dockge2/.dockge2/update --version X.Y.Z --yes
```

The same engine is behind `bash install.sh --update --dir /opt/dockge2` and, in a source checkout,
`npm run update-docker -- --dry-run`. npm is optional and needs no dependencies installed.

## What happens during an update

1. Everything that can fail without an outage runs first: the download, signature checks,
   validation of the configuration, a free-space check.
2. The updater locks the Compose project, keeps the running image under a `dockge2-recovery:<id>`
   tag, and stops only the panel.
3. The panel data is copied and the copy is verified, SQLite `integrity_check` included.
4. The new image starts by digest. Compose waits up to 180 seconds; readiness means the database and
   authentication are initialised, the reported version matches, and the container is still healthy
   10 seconds later.

The updater never fetches, resets or switches a Git checkout, so a newer `main` cannot change the
selected release. A run with nothing to change keeps the previous deployment as the rollback point.
See [verified self-updates](self-updates.md#cutover-and-recovery) for the full sequence.

## Channel and mirror

The updater records the image source, the channel, in `.dockge2/active.json`. With the default
`ghcr.io/mazixs/dockge2:latest` every run takes the newest stable release; with a version tag as
the channel, that version stays selected. `--version` chooses a release for one run and leaves the
channel as it is. Editing `DOCKGE_IMAGE` in `.env` does not change the channel either, and neither
does including prereleases in the check under Settings -> About. Switch it explicitly:

```bash
sudo /opt/dockge2/.dockge2/update --image ghcr.io/mazixs/dockge2:latest --dry-run
```

A mirror has to serve the signed digest. An unknown custom or local image is refused unless you
choose it explicitly, and `--yes` alone never authorises a change of source.

## Changing the configuration

Edit `/opt/dockge2/.env`, then run the updater. To change only the configuration and stay on the
installed version, name that version (Settings -> About shows it):

```bash
sudo /opt/dockge2/.dockge2/update --version X.Y.Z --dry-run
sudo /opt/dockge2/.dockge2/update --version X.Y.Z --yes
```

The preview lists the names of the changed variables, never their values. Overrides passed with
`--compose-override` are remembered. Changing mounts, the data directory or the stacks directory
of an existing installation is refused, see [installation](installation.md#ssh-keys-registry-logins-and-certificates).

## Rollback

```bash
sudo /opt/dockge2/.dockge2/update --rollback --dry-run
sudo /opt/dockge2/.dockge2/update --rollback --yes
```

Rollback starts the recorded previous image with its exact previous configuration. It downloads
nothing and checks out nothing.

When the database schema changed between the two versions, rollback also needs the data snapshot
taken before the update:

```bash
sudo /opt/dockge2/.dockge2/update --rollback --restore-data --yes
```

This discards what the panel wrote after the update. The newer data is kept next to the data
directory as `*.dockge-failed-<operation>`. Stack files and stack volumes are not restored.

## Interrupted updates

If an update fails before the new panel started, or the schema did not change, the updater restarts
and verifies the previous panel on its own. Otherwise the operation stays `recovery-required`, with
the failed target stopped, and a new update refuses to start over it:

```bash
sudo /opt/dockge2/.dockge2/update --status          # what happened
sudo /opt/dockge2/.dockge2/update --resume --yes    # retry the same target after fixing the cause
sudo /opt/dockge2/.dockge2/update --rollback --yes  # or go back
```

The recovery tool is installed on the host, so it works even when the panel cannot start. A failed
first installation has no previous deployment: keep its data and journal for diagnosis rather than
deleting them. [Recovery in detail](self-updates.md#cutover-and-recovery).

Snapshots and recovery images are never pruned automatically. Review disk use yourself, keep the
set the latest journal refers to, and never run a global `docker image prune` as part of updating.

## Upgrading an older installation

Releases before `0.0.10` had no signed updater. Do not run the old checkout's installer or npm
updater for the migration. Download and review the installer of the new release as in
[installation](installation.md#install), then:

```bash
sudo bash /tmp/dockge2-install.sh --update --dir /opt/dockge2 --version X.Y.Z --dry-run
sudo bash /tmp/dockge2-install.sh --update --dir /opt/dockge2 --version X.Y.Z --yes
```

After that, use `.dockge2/update`; the old checkout keeps its old scripts. What the import accepts:

| Running now | Route |
| --- | --- |
| `0.0.8` with its original `docker-compose.yml` | The commands above |
| `0.0.10` pulled by an old script, without `.dockge2` | The commands above with the `0.0.12` installer or newer, see [unmanaged 0.0.10](self-updates.md#unmanaged-0010-installations) |
| `0.0.7` | First the published `0.0.8` image, then the import, see [from 0.0.7](self-updates.md#from-007-to-0010) |
| A local build | Add `--image ghcr.io/mazixs/dockge2:latest` to choose the published releases |

The updater checks the running version, the mounts and the environment, and refuses an ambiguous
installation or an edited vendor Compose file before any downtime. Keep your Compose edits in an
explicit `--compose-override` file after comparing them with the original release; never discard
them to satisfy the import. `--compose-file` points at the original base under another name and
`--project` names a custom Compose project. Do not downgrade panel data to regain an older route.
Details are in [legacy import](self-updates.md#legacy-import).

## Development builds

A build of a branch or commit is separate from release updates. It needs Git and about 1 GB of RAM
for the frontend build:

```bash
sudo /opt/dockge2/.dockge2/update --development --ref YOUR_REF --yes
```

The ref is fetched into temporary staging and its resolved commit is recorded. A failed release
download never turns into a build, and an unknown local deployment has to be imported through a
supported release first. For day-to-day work on the source, see
[development](development.md).
