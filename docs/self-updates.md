# Verified self-updates

Release installation is a host-side operation. It does not use the browser, update stack images,
fetch a production branch, or modify the user's checkout. `install.sh` authenticates a native
updater; `extra/update-dockge.sh` is the optional npm entry point to the same engine in
`extra/updater/`. Only explicit `--development --ref REF` builds source.

## Release contract and trust

A release contains `release.json`, its Sigstore bundle, `docker-compose.yml`, `install.sh`, and
Linux amd64/arm64 updater binaries with their own bundles. The signed descriptor binds version,
source commit, image index/platform digests, file sizes/hashes and compatibility requirements.
The application image is always pulled by the selected descriptor's digest, including at a mirror.
The downloaded image's platform, version and revision labels are checked before cutover.

The bootstrap's initial trust root is the operator-reviewed released script over GitHub HTTPS.
It pins Cosign 3.1.3 and the architecture-specific binary checksum from the
[official release assets](https://github.com/sigstore/cosign/releases/expanded_assets/v3.1.3).
Both bootstrap and engine require this exact signer identity for version `VERSION`:

```text
https://github.com/mazixs/dockge2/.github/workflows/release.yml@refs/tags/vVERSION
issuer: https://token.actions.githubusercontent.com
```

Cosign verifies the bundle and transparency material; there are no signature-bypass flags.
This is a publisher/workflow trust policy, not proof that the publisher's code has no bugs.
Compromise of the repository's release workflow remains inside this trust boundary. Protect tags,
review workflow changes and enable immutable GitHub releases. The package must permit anonymous
pulls. [Cosign bundle verification](https://docs.sigstore.dev/cosign/verifying/verify/).

The engine checks a minimum protocol version. For a new protocol or verifier rotation, download and
review the new released bootstrap and force the bootstrap path explicitly:

```bash
sudo bash /tmp/dockge2-install.sh --bootstrap --update --dir /opt/dockge2 --version X.Y.Z --dry-run
sudo bash /tmp/dockge2-install.sh --bootstrap --update --dir /opt/dockge2 --version X.Y.Z --yes
```

This bypasses the old launcher, not verification. Updating the pinned verifier requires checking
upstream release checksums, updating both bootstrap and CI helper, and reviewing that trust change.
A `--release-dir` can supply local signed assets; initial Cosign trust-root initialization may still
need network access. Recorded image/configuration/data rollback itself requires no downloads.

The bootstrap forwards interruption to the native updater and waits for recovery before removing
its temporary verifier. `--resume` and `--rollback` use the recorded source; combining them with
a new version/image selection is rejected.

## WebUI results

The About screen discovers releases; installation runs through the host updater. Discovery keeps
network errors, deadlines, GitHub rate limits, HTTP failures, invalid responses and channels without
a complete release distinct. A failed check preserves the last successful timestamp and does not
claim that the installed version is current. Losing the browser acknowledgement is a separate
connection result.

Stack/service updates from WebUI are Compose operations. They report the failed command stage
(pull, build or container application), a busy operation, or an unavailable command. Cancellation
and lost acknowledgements require checking the current state before retrying; some changes may
already have occurred. Parsed log lines never override the final acknowledgement.

## Installation identity and files

The engine supports one `dockge` service, Linux amd64/arm64, and a local Unix Docker endpoint.
It identifies the daemon and Compose project, then verifies the container's Compose working-directory
label. Every command passes the project, project directory and configuration file explicitly.
Implicit `COMPOSE_FILE`, adjacent override discovery and directory-name guesses are not used.
Remote contexts, named data volumes, symlinked data paths and ambiguous legacy setups fail closed.

The existing `.env` is not rewritten. An imported `.env` image determines the initial desired source;
a managed installation records that choice in `active.json`. Change it with `--image`, not by editing
the preserved `DOCKGE_IMAGE` line. Configuration changes go in `.env` or explicit repeatable
`--compose-override` files, and their field names appear in the preview without printing values.
The new configuration is checked again immediately before stopping the panel. Mount path changes
require a separate migration.

Managed state is under `<installation>/.dockge2`, outside the panel data directory:

| File | Meaning |
| --- | --- |
| `active.json` | Installed release, actual image ID, desired source, project, paths and overrides |
| `operation.json` | Durable phase and recovery information for the last operation |
| `previous.json` | Last distinct successful deployment and its snapshot; no-op runs retain it |
| `operations/<id>/release/` | Verified release files and next host updater |
| `operations/<id>/target.json`, `previous.json` | Resolved Compose snapshots; may contain secrets |
| `operations/<id>/data-backup`, `data-backup.sha256.json` | Stopped data and verified file hashes |
| `bin/cosign`, `update` | Persisted verifier and atomically replaced launcher |

The state directory is private; managed files containing configuration are `0600`. Do not put state
under the database or stack directory. Already resolved dollar signs are escaped when serializing
Compose snapshots so passwords are not interpolated a second time. The previous snapshot comes
from the previously deployed configuration, even if `.env` was edited before the next update.

A nonblocking file lock in `/tmp` is keyed by daemon ID and project, shared by both entry points and
independent of `TMPDIR`. A second lock serializes operations on the same data path across projects.
Fresh installation refuses nonempty data; writable data mounts in other running containers block cutover. Its inode is never unlinked while using the updater. Do not delete it to
bypass an active operation. Atomic rename plus file/directory synchronization protects metadata;
Docker, files and SQLite are still separate operations, so the journal is required for recovery.

## Cutover and recovery

The sequence is verification and preview, image pull, previous-image retention, configuration
recheck, free-space preflight, stop, snapshot and integrity check, start, readiness, stability check,
then success. Image retention uses the actual container image ID, with a `dockge2-recovery:<id>` tag.
A pre-pulled mutable tag cannot replace it. No automatic cleanup prunes images or old snapshots.

The backup assumes the panel is the only writer of its data directory. The panel is stopped before
copying, including SQLite WAL files, and the copy is hashed, flushed and checked with SQLite's
`integrity_check` using the previous image with no Docker socket and no network. A failed partial
snapshot is removed before attempting recovery. Concurrent host writes can still exhaust free space;
a preflight is not a storage reservation. [SQLite backup constraints](https://www.sqlite.org/backup.html).

The readiness endpoint requires successful application/auth initialization and queries essential
tables. HTTP errors, redirects, HTML, oversized responses or a different version fail the Go probe.
Compose waits up to 180 seconds; the engine then verifies the exact image, application version and
probe, and checks identity/health/restart count again after 10 seconds. Health polling is every
10 seconds, timeout 6 seconds; `start-period=60s` tolerates early failures rather than delaying probes.
[Docker health semantics](https://docs.docker.com/reference/dockerfile/#healthcheck).

An unchanged schema permits automatic image/configuration recovery without data restoration.
Before target startup, the previous panel can be recovered independently of the target schema.
Schema identity includes migration files, auth code and resolved dependency identities; a release
number change alone does not change the schema hash. Other schema changes require explicit data
restoration. Missing future migrations now stop application startup instead of allowing a downgrade.

```bash
sudo .dockge2/update --status
sudo .dockge2/update --rollback --dry-run
sudo .dockge2/update --rollback --yes
sudo .dockge2/update --rollback --restore-data --yes
sudo .dockge2/update --resume --yes
```

`--restore-data` is explicit consent to replace the active panel data with the verified snapshot.
Newer data is preserved beside it as `.dockge-failed-<id>`. A staged replacement and the recorded
restore intent allow a retry after interruption between directory renames. This does not restore
stack files or volumes. Preserve failed data until the incident is understood.

`--resume` retries the recorded target after an external problem has been fixed; it never changes
the target release or restores data. It refuses phases without a completed backup for an existing
installation. An interruption before cutover can be marked failed with `--rollback`, without
recreating a running panel. A failed first installation has no previous release to roll back to:
retry its recorded target with `--resume` when the initial configuration was written. If it was not,
mark preparation failed with `--rollback` and repeat the fresh installation. Preserve the journal
and any created data; do not resolve an unknown state by deleting the directory.

Use the same administrative account that owns the installation state. A missing previous local
image, corrupt snapshot or unexpected running container blocks recovery; no mutable tag substitutes
for missing evidence. Keep the latest journal, its two referenced configurations, their release
files, the launcher target, verifier, backup and retained image before doing manual disk cleanup.

## Legacy import

The initial signed contract recognizes `0.0.8`. Import verifies the running package version,
schema-bearing files, mounts, environment, published ports and exact released vendor Compose hash.
The original checkout and `.env` remain untouched. The old checkout remains old: after import use
`.dockge2/update`; migration does not rewrite its old installer or npm scripts. Local builds with a different schema are refused,
even when their package still says `0.0.8`.

Download the new released bootstrap rather than executing the old installation's updater. A local
image requires an explicit `--image ghcr.io/mazixs/dockge2:latest` to choose the release source.
For an advanced checkout, preserve edits and supply the matching old base through `--compose-file`;
its bytes are checked against the signed import contract. Put understood customizations in explicit
overrides. Do not replace or reset the user's working copy to pass this check. After rollback to a
legacy installation, the same import choices may be needed again.

### From 0.0.7 to 0.0.10

There is no direct `0.0.7` import contract in `0.0.10`. First run the published `0.0.8` image
with the original `0.0.7` Compose file, then import that running panel with the signed `0.0.10`
bootstrap. The released `0.0.7` and `0.0.8` Compose files have identical bytes. This route was
checked with an isolated `0.0.7` installation and an existing owner account; the `0.0.8` to
`0.0.10` migration and restore are release gates on both architectures.

Before changing the image, record the actual Compose project, data and stack paths. Back up the
panel data while its container is stopped, along with `.env` and `docker-compose.yml`. The panel
data can be root-owned even when Docker commands work without sudo. Keep the backup outside the
data directory and preserve its permissions. The commands below assume `/opt/dockge2` and the
original vendor Compose file; use the real installation directory and project name if different.
The signed updater requires Docker Engine 24+ and Compose 2.20+.

```bash
cd /opt/dockge2
sha256sum docker-compose.yml
# Expected 0.0.7/0.0.8 vendor hash:
# baa4b0b12dd7abca6ba22a5f9485013fe80f59cecfb452e79ec6b08b9a033cba
docker compose -f docker-compose.yml exec -T dockge node -p "require('/app/package.json').version"
# Confirm 0.0.7, then stop only this panel and back up its actual data path.
docker compose -f docker-compose.yml stop dockge
sudo install -d -m 700 /secure/backup
sudo cp -a /actual/panel/data /secure/backup/dockge-data-before-0.0.8
sudo cp -a .env docker-compose.yml /secure/backup/
```

In the existing `.env`, change only `DOCKGE_IMAGE` to the published `0.0.8` image index digest
`ghcr.io/mazixs/dockge2@sha256:5c050694a1949cadf65e99f8aad9e9a845c82575bf9ba6e8b4618f9fbcd5deea`.
Keep the data, stack paths, port and other settings. Then:

```bash
docker pull ghcr.io/mazixs/dockge2@sha256:5c050694a1949cadf65e99f8aad9e9a845c82575bf9ba6e8b4618f9fbcd5deea
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml up -d --no-build --pull never --wait --wait-timeout 180
docker compose -f docker-compose.yml exec -T dockge node -p "require('/app/package.json').version"
# Confirm 0.0.8 and sign in with the existing account before continuing.
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://github.com/mazixs/dockge2/releases/download/v0.0.10/install.sh \
  -o /tmp/dockge2-install-0.0.10.sh
less /tmp/dockge2-install-0.0.10.sh
sudo bash /tmp/dockge2-install-0.0.10.sh --update --dir /opt/dockge2 \
  --version 0.0.10 --image ghcr.io/mazixs/dockge2:latest --dry-run
sudo bash /tmp/dockge2-install-0.0.10.sh --update --dir /opt/dockge2 \
  --version 0.0.10 --image ghcr.io/mazixs/dockge2:latest --yes
```

Use the same Docker daemon and installation owner for both signed-updater commands. The explicit
`--image` selects the release channel after the temporary `0.0.8` digest pin in `.env`; the old file is
not rewritten. If the vendor Compose hash differs, or the panel was built locally, do not replace
its files to pass this check. Preserve the custom configuration and establish an explicit legacy
base/override before importing. If the `0.0.8` step fails, recover the stopped-data backup and
the saved `.env`/Compose file before restarting the old image.

## Publishing and acceptance

`release.yml` runs only with a tag identity and serializes publication. It checks package/tag
agreement, repository checks, builds and browser/Docker tests, builds one multi-platform candidate
with provenance/SBOM, signs the descriptor and binaries, and exercises fresh install, `0.0.8` import,
owner login, exact-image readiness, no-op and data restore on both architectures under QEMU.
When a previous managed stable release exists, it also exercises that release's installed updater
and rollback. Anonymous pulls and asset downloads are checked. Only that tested digest is promoted.

A complete existing release is reused and verified on retry; its artifacts are not replaced.
Publication compares all published stable versions and the current `latest` label before promotion.
An older tag or prerelease cannot rewind `latest`. A partial public release with missing assets fails
closed. Recover the original verified artifacts if available; otherwise publish a new version rather
than substituting rebuilt bytes under an already advertised version. Release discovery ignores
incomplete asset sets; installation independently verifies signatures and hashes.

External release actions are pinned to reviewed SHAs. Dependabot proposes action updates weekly;
review the upstream release/commit and rerun the gates before accepting a new pin. The former direct
npm/nightly publishing commands now refuse to bypass this workflow.

`npm run test:install` is local contract/failure testing, not evidence of a real deployment. The
Docker gates require an isolated CI runner and operate only on uniquely named fixture projects.
Publication and production acceptance remain unverified until that workflow actually passes.
