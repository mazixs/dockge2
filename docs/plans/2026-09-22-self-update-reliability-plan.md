# Self-update reliability plan

Status: proposed implementation plan. No runtime changes, release or deployment performed.

Baseline: `3f830768eeca540f50b1fe199b248164fbf0311b`, reviewed on 2026-09-22. The existing untracked [audit](2026-09-22-self-update-audit.md) is preserved. Its U01-U10 findings supply the supporting reproductions.

## Primary correction

Production must install a coherent, verified release: its image, Compose configuration and update tooling. Advancing `main` must not change any part of that installation. A broken development branch must have no effect on a normal production update.

The current installer fast-forwards a branch at `install.sh:545-568`, then independently pulls the default image at `install.sh:704-713`. A failed pull can instead build the branch. The npm updater has the same independent Git/image sources. This disagreement is the foundational defect; fixing healthchecks or adding retries alone does not resolve it.

The plan retains a moving stable channel (`latest`) for discovering new releases. Each operation resolves that channel once and installs the resulting immutable image identity with its matching deployment files. This does not permanently pin an installation to one release. Docker distinguishes mutable tags from immutable digests, including the index and platform-specific digests of multi-platform images. [Docker image digests](https://docs.docker.com/dhi/explore/security-concepts/digests/).

## Required behavior

| Situation | Required result |
| --- | --- |
| `main` is ahead, broken, force-pushed or unavailable | Stable release installation/update is unaffected; no branch files are consumed. |
| Registry/release service is unavailable | Stop before cutover with a useful error; keep the current deployment and configuration. No implicit source build. |
| A newer release appears during an update | Finish with the release selected at the start; do not mix its artifacts with the newer release. |
| Image/configuration provenance or checksums disagree | Reject before executing downloaded tooling or recreating the panel. |
| A custom registry, mirror or channel is configured | Preserve it; require matching trusted release metadata or stop with a clear unsupported-source message. |
| No image or effective configuration change | Report no update; do not recreate containers or rotate rollback history. |
| Cutover has already started and fails | Recover according to the recorded schema policy, or report `recovery-required`; never claim that the old deployment is still running without checking. |
| An operator requests development code | Require explicit development mode plus a source ref, resolve it to a commit and label the result as a development build. Never enter this mode as fallback. |

Updates stay host-side administrative operations. No arbitrary Git/shell/Docker execution event is added to Socket.IO. Managed application stacks are outside the panel-update scope. A brief panel outage during cutover is acceptable; zero-downtime deployment is not promised.

## 1. Establish the release contract and stop reading `main`

**Priority:** first. **Coverage:** foundational defect, U02, U03, U08.

Produce a deployment bundle from the same tagged commit as the application image. Include the Compose template, the released installer/update tooling, compatibility information and a machine-readable release descriptor. The descriptor binds:

- semantic version, immutable source commit and release channel;
- image repository, manifest-index digest and supported platform manifests;
- deployment-bundle hash and configuration-format version;
- minimum updater/Engine/Compose versions and supported upgrade-from versions;
- database schema compatibility and whether rollback without data restoration is supported;
- verification material identifying the expected publisher and workflow.

Treat the descriptor as data: strict schema, bounded size and safe extraction paths. Reject traversal, unexpected file types and executable hooks not covered by the verified release. A checksum from the same untrusted download is not proof of publisher identity.

Publish complete release artifacts before advertising a channel. Resolve the desired channel/version to a complete descriptor once; stage all downloads and verify them before changing the installation. Install the selected image by digest. Keep the desired channel separate from the recorded installed version/digest. Incomplete cross-service publication must yield a retryable error or the previous complete release, never mixed artifacts.

Use a released bootstrap entry point in README instead of `raw.githubusercontent.com/.../main/install.sh`. Load update code from a verified versioned location; do not overwrite a script while that process is executing it. A newer updater must be authenticated by an already trusted bootstrap/verifier. Establish the verifier delivery and trust-rotation mechanism in this phase, including operation on both supported architectures without host Node/Python or a local build. Do not mark this phase complete while verification depends on an undocumented host tool.

Keep explicit source builds available. Default installation and update must not build on a download failure. Distinguish building a selected release from explicitly deploying a development ref; never interpret `--yes` as consent to change source or channel.

**Likely files:** `install.sh`, `extra/update-dockge.ts`, new release descriptor/bundle tooling, `.github/workflows/release.yml`, `README.md`.

**Acceptance:** Create a valid release fixture, then make `main` unusable by changing its Compose command, mounts and Dockerfile. Fresh install and update must still use only the release fixture. A branch-fetch spy must observe no production request for `main`. Mismatched commit/hash/digest, an incomplete release and a moving channel must not alter the active installation.

## 2. Use one update engine with explicit deployment identity

**Coverage:** U02, U05, U09, U10.

Move update orchestration into one host-side implementation. Keep `install.sh --update` and `npm run update-docker` as thin entry points to it; npm must not remain a second command generator with different safety behavior. Preserve the Docker-based installation's lack of a host Node requirement. The npm wrapper should remain usable even when an old checkout cannot load its previous TypeScript dependencies.

Resolve the effective existing deployment from its Compose/container metadata and operator configuration: Docker endpoint, project name, service/container identity, explicit file/override set, image ID, ports and actual mounts. Check ownership of that deployment before mutating it. A directory name or the fixed project name `dockge2` alone is insufficient.

Use the same explicit Compose file set, project directory and project name in validation, pull, deployment, inspection and rollback. Preserve shell/`.env`/override precedence deliberately. Do not infer registry versus build mode from whether the image contains a slash.

Stage versioned release files outside the user's working Git tree. Keep user settings and accepted overrides separate from vendor release files. Preserve `.env` bytes unless a setting change is explicit; inject the resolved image digest through managed deployment configuration. Resolve relative paths against the original deployment directory, so staging does not move `./data`, certificates, env files or other bind mounts. Local Compose customizations require comparison and an explicit resolution when they conflict; never rewrite or silently discard them.

Provide a read-only preview with current/target version, source, configuration changes with secrets redacted, restart consequence and recovery requirements. Give each mutation phase a useful progress message and retain bounded, redacted command stderr.

**Acceptance:** Both entry points produce the same effective update. Cover alternate `compose.yaml`, `COMPOSE_FILE`, custom project names, Docker contexts, relative mounts, external data directories, quoted environment values, local edits and mirrors. Verify another project and its containers remain untouched.

## 3. Make interruption and concurrent execution recoverable

**Coverage:** U04, U09, U10.

Acquire one lock shared by all entry points, keyed by the resolved Docker endpoint/project identity so another invocation through a different directory cannot bypass it. Inspect for an unfinished operation before starting another. Do not break a lock solely because it is old.

Use a durable operation record outside the application data snapshot. Record operation ID, source and target identities, original configuration references, backup location, phase and outcome. Store files containing settings/secrets with restricted ownership and permissions; logs and ordinary status JSON must not contain their values.

The operation phases are:

```text
resolve -> verify -> stage -> validate -> capture previous state
        -> stop panel -> backup -> start target -> verify runtime -> commit success
```

Before cutover, the old panel stays running. After cutover, failure enters a recorded recovery path. Cancellation is immediate before mutations and controlled during cutover. Stage and atomically replace managed files on the same filesystem, with persistence ordering appropriate for crash recovery. A rename does not make Docker, files and SQLite one atomic transaction: on resume, reconcile the journal against actual container image, configuration and database state.

Keep the last distinct successful deployment and the verified previous image. No-op runs and retries must not rotate it away. Cleanup is scoped to recorded Dockge2 update artifacts, never global Docker prune.

**Acceptance:** Inject termination and write/disk failures at every phase. Re-run the command and verify a bounded, understandable recovery path. Start both entry points concurrently, including through different install paths; only one may mutate the project. A successful no-op must retain the previous distinct release.

## 4. Define truthful readiness and data-safe rollback

**Coverage:** U01, U04, U06.

Add a minimal readiness endpoint and make the Go probe validate its expected status and response. Report ready only after required initialization and migrations succeed and the essential database/auth state is usable. Keep checks bounded and exclude the health of unrelated managed stacks or external update services. A running process or an HTML error page is not readiness.

After Compose startup, verify the actual image ID/digest, reported application version and expected deployment identity, followed by a short bounded stability window that detects crashes/restarts. A healthy but wrong image must fail the update. Return distinct outcomes such as success, no change, failed before cutover, recovered, and recovery required.

Capture rollback from the actual running container's immutable image ID before pulling/building a replacement. Retain the exact previous Compose/override/environment configuration. A tag pointing at a pre-pulled new image must not replace this evidence.

For the first implementation, choose a maintenance-window backup: download and validate everything while the old panel runs, then stop its writers and create a verified snapshot of the effective panel data directory before the new image starts. Preserve WAL-related files and required secret/configuration files; perform an integrity/restore check on the snapshot. On backup failure, restart and verify the old deployment. Never run old and new panels against the same writable SQLite data simultaneously. A future online backup optimization should use a documented SQLite snapshot method rather than copying a live database file. [SQLite backup methods](https://www.sqlite.org/backup.html).

Automatically recover the previous image/configuration only when the schema policy and tested upgrade path permit it. When data restoration is required, stop the failed writer, preserve its data for diagnosis, and require an explicit restore if newer user writes could be discarded. Do not restore managed stack/container data as a side effect of restoring the panel. A crash after accepting traffic must never trigger an unannounced database rewind.

**Likely files:** `extra/healthcheck.go`, `backend/routers/main-router.ts`, `backend/dockge-server.ts`, `backend/database.ts`, migration metadata, updater and `docker/Dockerfile`.

**Acceptance:** Test 404/500/503, wrong response, unready database, failed migration, wrong image, restart loop and startup timeout. Complete an isolated upgrade and restore, checking owner login, settings, stack files, data paths and database integrity. Prove compatible rollback and explicit incompatible-schema recovery separately.

## 5. Publish only the artifact that passed release checks

**Coverage:** U07, U08 and obsolete alternate publishing paths.

Require repository checks for the exact tagged commit, tag/package-version consistency, release-contract validation and supported upgrade-path tests. Build a candidate artifact once, run smoke/upgrade tests against its digest for amd64 and arm64, and promote that tested digest without rebuilding. If testing requires registry storage, use a candidate namespace/tag excluded from stable discovery. Docker documents testing an image before publication; this project additionally needs upgrade and recovery acceptance. [Docker test-before-push](https://docs.docker.com/build/ci/github-actions/test-before-push/).

Sign/bind the image and deployment bundle to the expected repository/workflow identity; publish provenance and SBOM information. Pin external release actions to verified commit SHAs with an update process. Consumer verification must enforce the same identity policy before installing the artifacts; emitting metadata alone is insufficient.

Serialize channel promotion and compare versions at promotion time. Rerunning an older tag must not move `latest` backwards; prerelease/nightly must not move it at all. Make retries idempotent. An intentional release rollback requires an explicit, recorded publishing action. Preserve or verify the existing artifacts for a released version instead of silently replacing them.

Reconcile `release-final`, `release-beta`, `release-nightly` and manual image-push commands with this gate. They must not bypass it or claim unsupported architectures. Verify anonymous access to all required public release artifacts, not merely successful publisher login.

**Acceptance:** A failed check, wrong version, unverified artifact, unavailable architecture or failed upgrade test prevents stable promotion. Test concurrent releases, an old-tag rerun, partial publication and recovery after an interrupted promotion. Test wrong signer/workflow as well as bad checksums.

## 6. Migrate existing installations without running the legacy updater

**Coverage:** transition risk absent from the original audit's primary findings.

Ship a first compatible release with a documented migration entry point loaded from that release. Do not tell existing users to run the old `--update` as the migration step: it still fetches a branch and can execute the old build fallback.

Import the actual running image and effective configuration as a legacy baseline. Preserve Git history, dirty files, `.env`, data and stack paths. Do not reset or checkout the user's repository to a release tag. A legacy version without a descriptor needs a specific tested import path; do not assume it supports the new contract. Where identity or configuration cannot be established, stop before mutation and explain the missing information.

Migrate both existing local-build deployments and registry deployments explicitly. Preserve an intentionally selected source/channel. `--image-only` may remain as a documented compatibility mode only when installed configuration is verified compatible with the target release; it must never turn into a source build or claim the full release bundle was updated.

Ensure the released updater can update itself through the established trust policy without executing a partially replaced script. Keep recovery tooling usable when the new application fails to start.

**Acceptance:** Upgrade a fixture representing the current `0.0.8` contract, one local-build installation, a custom-directory installation and a dirty checkout. Validate the recovery path from each. Use only fresh test data; do not test against the user's panel.

## 7. Align discovery, instructions and operational status

**Coverage:** U02, U10 and audit observations about discovery freshness.

Use the same eligible release metadata for checking and installing. Keep discovery opt-in; enabling beta discovery must not silently change the installation channel. Show the release/channel that an installation command will select, and distinguish discovered, downloaded, installed and healthy versions.

Record the last successful discovery time and failure state; do not imply a stale result is a fresh confirmation. Handle release pagination/channel selection and version compatibility. Preserve the existing request deadline and shutdown cancellation behavior.

Update README, help output, supported runtime versions and recovery instructions. Include source/channel behavior, bounded wait requirements, maintenance downtime, backup location, restore consequences and custom-image limitations. Remove branch-based production instructions and inaccurate healthcheck timing claims. Keep UI changes confined to update information and translated strings.

**Acceptance:** A beta notice cannot suggest a command that silently installs stable instead. Offline/error states are distinct from up-to-date. Every documented installation, update and recovery command is exercised against an isolated release fixture.

## Delivery sequence and release gates

| Increment | Scope | Gate before proceeding |
| --- | --- | --- |
| A | Release descriptor/bundle, trust bootstrap, producer and consumer contract tests (step 1) | A broken `main` cannot influence the selected release; no executable artifact is consumed before verification. |
| B | Shared engine, explicit deployment identity, staging/lock/journal (steps 2-3) | Both entry points pass the same failure and concurrency contract. |
| C | Readiness, backups and rollback (step 4) | Real isolated Docker upgrade/restore passes for compatible and incompatible schema paths. |
| D | Publication and legacy migration (steps 5-6) | The exact artifact is tested on both architectures; the current installation contract can migrate without the legacy updater. |
| E | Discovery/docs and final acceptance (step 7) | All operator instructions and error outcomes are verified; audit findings are rechecked against implementation. |

These are implementation increments, not permission to publish partial fixes as a fully reliable updater. No production promotion until the gates below pass. A risk-reduction patch may ship separately only with its remaining limitations stated.

## Final acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| Broken/ahead/rewritten `main` | Release install and update use the same immutable source/image/bundle, with no branch dependency. |
| Registry outage, auth error, missing image, wrong signature or checksum | No build fallback, no active config change and no panel restart before cutover. |
| Channel changes during download | One consistent selected release, or safe rejection. |
| Unknown custom image/configuration | Explicit compatibility outcome; no silent switch to default `latest`. |
| Wrong Compose file/context, two installations | Only the recorded deployment is addressed; unrelated containers and stack files stay unchanged. |
| Failed readiness or wrong version | No success report; verified recovery or explicit recovery-required status. |
| Pre-pulled mutable tag and repeated no-op | Rollback retains the actual previous working image/configuration. |
| Concurrent commands, `SIGTERM`/`SIGKILL`, disk full, interrupted write | Single writer, complete files and resumable/recoverable recorded phase. |
| Migration and failed rollback | Consistent verified backup, preserved failed data, no implicit loss of newer writes. |
| Older/concurrent release publication | Stable channel stays on the eligible tested version. |
| Legacy upgrade and released updater upgrade | Existing paths/settings/secrets retained; no call to the legacy branch updater. |
| Host restart following success/failure | Correct deployment identity and recovery status after restart; persistent data intact. |
| Low-memory host | Registry update requires no frontend build; download/backup space failure is handled before unsafe cutover. |

Use unit and fixture tests for selection/validation, actual Compose parsing for configuration, and real isolated Docker installations for lifecycle and recovery. Stub tests alone cannot establish container, signal, mount or SQLite recovery correctness. Keep immutable release fixtures and fault-injection evidence reproducible in CI.

For application changes, run `npm run check`, installer tests, frontend build where required by repository policy, and affected Docker/browser checks. The audit environment currently denies listening sockets; full integration acceptance must run in CI or a permitted isolated environment. An unavailable check is an open gate, not a pass.

Done means the implementation, published artifact and upgrade/restore evidence agree. A completed plan, green unit tests or a successful image build alone does not establish deployment reliability.

## Local implementation status

Implementation and verification are tracked in [the implementation report](2026-09-22-self-update-implementation.md). The release/production gates above remain open until the real CI workflow and published artifact checks pass.
