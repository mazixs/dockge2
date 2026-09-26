# Updating

The panel is updated by the updater that the installer placed in `<installation>/.dockge2/update`.
An owner can start it from Settings -> About, or run it on the host. Both run the same updater with
the same checks, the same data snapshot and the same recovery. Settings -> About checks for releases
when the owner asks, or on a schedule once automatic checks are enabled.

Updating the panel never touches your stacks: their images are updated from the stack page, and
their containers are not restarted when the panel is.

## Update from the web interface

1. Settings -> About -> **Prepare update to <version>**. The panel runs the updater's preview: the release is
   verified, nothing is downloaded or changed. You see the current and target versions, the
   configuration fields that change, and whether the database schema changes.
2. **Update to <version>** and confirm with your password within ten minutes of the preview.
3. The page stays open and follows the steps: download, stop, save data, start, verify. While the
   panel restarts the page loses its connection for a minute or two; your stacks keep running. Do
   not reload the tab while the panel is offline - the browser would show its own error page. If you
   did, reload again once the panel answers; the progress comes back.
4. The page ends on one result:
   - **Updated to Dockge2 X** - the new version answers and the updater confirmed it; the page
     reloads into it.
   - **Not updated: Dockge2 X keeps running** - the update was refused, cancelled, or failed before
     the panel stopped.
   - **Not installed: Dockge2 X runs again** - the new version did not become ready, so the updater
     brought the previous one back. When the schema had changed, the data snapshot taken before the
     update was restored and the data the failed version wrote is kept next to the data directory as
     `*.dockge-failed-<operation>`.
   - **The update needs attention on the host** - recovery did not finish; the page shows the
     commands to run, see [interrupted updates](#interrupted-updates).
   - **The result of the update is unknown** - the updater was killed without a result, for example
     by a Docker restart; the page shows the step it stopped at and the commands to continue or roll
     back.

Downloading can be cancelled; once the image is downloaded the update runs to its end. Other users
see a banner while the update runs. The update runs in a separate short-lived container
(`dockge2-update-<project>-apply`) so that it survives the panel stopping; it is removed when the
owner closes the result.

The button needs an installation managed by the updater, a panel running as that installation's
container, and a data directory bind-mounted from the host. Otherwise, and for installations whose
updater predates this feature, About shows the host commands instead. One update from the host
installs an updater that the web interface can drive.

## Update on the host

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
and verifies the previous panel on its own. When the schema changed and the new panel never became
ready, an update started from the web interface also restores the data snapshot and starts the
previous panel; on the host, add `--restore-on-failed-start` to `--yes` for the same behaviour.
Otherwise the operation stays `recovery-required`, with the failed target stopped, and a new update
refuses to start over it:

```bash
sudo /opt/dockge2/.dockge2/update --status          # what happened
sudo /opt/dockge2/.dockge2/update --resume --yes    # retry the same target after fixing the cause
sudo /opt/dockge2/.dockge2/update --rollback --yes  # or go back
```

Once the data snapshot was restored, or its restore began, `--resume` refuses: the new version
would migrate the restored data again. Finish with `--rollback --restore-data --yes`, then start a
new update. If `--status` stays on `rolling-back` after the updater has exited, a restore container
(`dockge2-restore-<project>-<operation>`) may still be running: wait until it has exited, then roll
back.

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
