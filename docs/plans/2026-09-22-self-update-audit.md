# Self-update and release-delivery audit

Date: 2026-09-22. Checkout: `main`, commit `3f830768eeca540f50b1fe199b248164fbf0311b`, package version `0.0.8`.

The working tree was clean before the audit. Application code, workflows and checked-in tests were not changed. Findings describe this checkout, not a production deployment. Experimental deployments used temporary directories, local Git fixtures and a Docker stub. No application container, user stack, image or production database was changed.

## Assessment

Best practices are **partially implemented**. The architecture has useful safeguards: explicit administrative updates, opt-in release discovery, fast-forward Git updates, configuration validation, downloaded images, persistent data mounts and bounded health waiting. However, the current implementation does not reliably establish that the intended release was installed, that it is healthy, or that the previous working deployment can be recovered.

Five P1 findings affect update correctness or recovery. Five P2 findings concern migration recovery, release promotion, artifact verification, concurrent execution and diagnostics. P1 means a correction should precede reliance on unattended updates; P2 means a material resilience or assurance gap. Static policy gaps are distinguished below from reproduced behavior.

Keeping `latest` as the desired update channel is compatible with the recommendations. The missing safeguard is recording and using the actual resolved image identity for each operation, not permanently freezing installations on one version.

## Mechanisms in scope

| Mechanism | Current behavior |
| --- | --- |
| Release discovery | `backend/check-version.ts` reads GitHub releases on an explicit administrator request or every 48 hours when enabled. It does not install anything. |
| Settings -> About | Enables discovery, includes prereleases in discovery and offers a manual check. The suggested installation command is `./install.sh --update`. |
| `install.sh --update` | Fast-forwards a checkout, validates Compose, tags a rollback image, downloads a candidate or builds locally, then runs Compose with health waiting. |
| `install.sh --image-only` | Skips the Git update, but still enters the same image-selection and build-fallback code. |
| `npm run update-docker` | Separately implemented updater: checks clean Git state, pulls Git, validates Compose, pulls/builds an image and runs Compose. No rollback snapshot is created by this command. |
| Release delivery | `.github/workflows/release.yml` publishes images on `v*` tags or manual dispatch and creates a GitHub release after pushing images. Nightly publication is manual. |

Automatic discovery and automatic installation are different features. The absence of installation from the browser is an intentional and appropriate boundary, not a defect.

## Findings

### U01 - P1: Healthcheck accepts HTTP failures as healthy

**Evidence:** `extra/healthcheck.go:55-72`; `docker/Dockerfile:103`; `install.sh:745-760`; `extra/update-dockge.ts:216`.

The probe checks transport and body-read errors, but never rejects `resp.StatusCode`. A complete 404, 500 or 503 response reaches `Health Check OK` and returns normally. Both update commands rely on Docker's health status to decide whether startup succeeded.

**Reproduction:** Compiled the unchanged Go source alongside a temporary test harness. Real HTTP response bytes were supplied through `net.Pipe`, replacing only the transport's dial function because the execution sandbox prohibits listening sockets. Responses 200, 404, 500 and 503 all returned successfully; output included `Health Check OK [Res Code: 503]`. This is an executable probe of the original HTTP handling, not a real-container upgrade test.

**Impact:** An update can report success when the application serves an error page. A root-page response also does not establish that the database and essential backend operations are ready.

**Recommendation and acceptance:** Reject unexpected status codes and use a small readiness endpoint with an explicit response contract. Make readiness dependent on completed startup/migrations and usable essential application state. A working response must pass; 404/500/503, an incorrect body, a connection failure and a startup that never becomes ready must fail. Both update commands must propagate failure. Docker uses the probe's exit status, and Compose `--wait` trusts that result. [Docker HEALTHCHECK](https://docs.docker.com/reference/dockerfile/#healthcheck), [Compose up](https://docs.docker.com/reference/cli/docker/compose/up/).

### U02 - P1: Updating discards the configured image and channel

**Evidence:** `install.sh:665-670,704-713`; `frontend/src/components/settings/About.vue:31-36,61-63`; `backend/check-version.ts:154-158`.

The existing `DOCKGE_IMAGE` is read for the rollback tag, but not used to choose the next image. Without `--image`, the candidate always comes from `DOCKGE2_IMAGE_REPO` and `DOCKGE2_IMAGE_CHANNEL`, whose defaults select `ghcr.io/mazixs/dockge2:latest`. The downloaded candidate is written back to `.env`.

**Reproduction:** In a temporary existing installation, set `DOCKGE_IMAGE=ghcr.io/example/panel:nightly`, then run the original installer with `--image-only --yes` and a successful pull stub. The command pulled `ghcr.io/mazixs/dockge2:latest`, rewrote `.env` to that value and exited 0. The same candidate-selection block is used by `--update`.

**Impact:** An installation using a mirror, a prerelease, a selected version or a custom image switches sources without an explicit source-change option. Enabling beta discovery also does not make the UI's suggested update command install the displayed beta release.

**Recommendation and acceptance:** Treat the effective existing image/channel as authoritative unless a source change is explicitly requested. Align any displayed release-specific installation guidance with the selected release. Cover custom registries, mirrors, prereleases, version tags and the normal `latest` channel; an ordinary update must preserve the chosen source.

### U03 - P1: Any default pull failure changes the update into a source build

**Evidence:** `install.sh:704-741`; Git update at `install.sh:545-568`.

All failures of the default `docker pull` are suppressed and described as absence of a published image. A missing manifest, authentication failure, network timeout, TLS error and registry outage lead to the same fallback. The script rewrites `DOCKGE_IMAGE` to `dockge2:latest`, builds the checkout and starts it. Only an explicit `--image` makes pull failure stop the update.

**Reproduction:** Run `--image-only --yes` on the fixture with pull returning nonzero. The original script called `docker compose -f docker-compose.yml build`, changed `.env` to `dockge2:latest`, called `up` and exited 0 when the build/up stubs succeeded.

**Impact:** A registry failure changes both artifact origin and resource requirements. After `--update`, the fallback can deploy unreleased branch code; after `--image-only`, it can deploy an old checkout. A small host unexpectedly enters a memory-intensive build. The underlying pull failure is hidden.

**Recommendation and acceptance:** Fail closed for updates from a registry. Retain source builds as an explicit mode, and distinguish fresh-install fallback policy from update policy. Preserve `.env` and the running deployment on pull failure. Test missing manifests, denied authentication, timeout and registry errors separately; none should trigger a build during a normal registry update.

### U04 - P1: Rollback does not identify the previous running image reliably

**Evidence:** `install.sh:663-679,763-773`; `extra/update-dockge.ts:182-216`; `README.md:384-406`.

The installer tags the image referenced by `.env`, not the immutable image ID of the current container. If a previous pull or build moved that tag while recreation failed, the tag already points at the new image while the container may still use the old one. The reported rollback then captures the wrong image. The npm updater does not create a rollback image at all.

Rollback retention also runs after every successful invocation without comparing old and new image identities. Re-running an already completed update replaces the useful previous-version tag with another tag for the current version and removes the earlier tag.

**Reproduction:** Docker-stub traces confirm that the source of `docker tag` is the configured tag; the script never inspects the running container's image ID. Two successive successful fixture runs with distinct timestamps show the second deleting the first rollback tag. The retention trace is reproduced; loss of a particular real Docker image was not simulated or claimed.

**Recommendation and acceptance:** Inspect the actual container, preserve its immutable image ID, and record the old commit, effective Compose configuration and environment together. Retain the last distinct successful deployment. A no-op update must not rotate away the prior version. Exercise a pre-pulled tag, failed recreation, a retry and two no-op invocations. Verify that rollback selects the exact original image and waits for readiness. Tags can move; digests and image IDs identify actual content. [Docker image digests](https://docs.docker.com/dhi/core-concepts/digests/).

### U05 - P1: The npm updater can select a different Compose application

**Evidence:** `extra/update-dockge.ts:82-105`; `test/backend/update-dockge.test.ts:8-35`.

Every Compose call in the npm updater omits `-f docker-compose.yml`. This differs from the installer and the repository's deployment contract. Compose auto-discovery or `COMPOSE_FILE` can select another configuration; automatic override handling can also differ between the two updater paths. Existing tests assert the omitted filename as the expected command sequence.

**Reproduction:** Using the installed Docker Compose v5.5.1 parser in a temporary directory containing both files, `docker compose config --services` returned the service `other` from `compose.yaml`; `docker compose -f docker-compose.yml config --services` returned `dockge`. No daemon operation was performed. This alternate-file condition can occur with a tracked/ignored file or environment override; an ordinary untracked file would be caught by the npm updater's dirty-tree check.

**Recommendation and acceptance:** Use an explicit, consistent project directory and Compose file set for validation, pull, deployment, inspection and rollback. Decide how supported overrides are supplied and preserve that choice across all operations. Validate that the targeted existing container belongs to that installation. Test shadowing filenames, `COMPOSE_FILE` and execution from another directory. Project naming should isolate deployments rather than silently retarget them. [Compose project identity](https://docs.docker.com/compose/how-tos/project-name/).

### U06 - P2: Recovery covers image hints, but not a consistent data/configuration snapshot

**Evidence:** `backend/database.ts:32-40,192-208`; `install.sh:607-619,673-679,745-760`; `README.md:295-300,320-324,405-406`.

Database migrations run automatically on startup. Neither updater creates a consistent database backup or captures the pre-update `.env` and effective configuration. The installer prints recovery commands after selected failures, but does not restore the previous deployment; its recovery `up -d` hint also omits health waiting. Manual rollback can be a valid policy, but the current image/commit hint is not a complete recovery record.

The README correctly mentions stopping before one backup example, but another recovery example copies `data` while the application can still write. Both examples assume `./data`, although external data paths are supported and recommended. No destructive migration or real data loss was executed in this audit.

**Recommendation and acceptance:** Before a migration-capable upgrade, create and verify a backup of the effective data location using an application-consistent method, and retain configuration plus image identity. State rollback compatibility explicitly. Prefer a tested operator-driven restore when automatic data rollback could discard new writes. On an isolated database, exercise an upgrade followed by image/config/data restoration and verify integrity, owner access and settings. SQLite documents the online backup API and `VACUUM INTO` for consistent live copies. [SQLite backup](https://www.sqlite.org/backup.html).

### U07 - P2: Publication is not gated by tests of the release artifact, and `latest` can move backwards

**Evidence:** `.github/workflows/release.yml:9-17,21-28,39-116`; `.github/workflows/ci.yml:3-15`; `package.json:27-32`.

The release workflow builds and pushes without running or requiring the repository checks or a startup test of the produced image. The separate CI workflow is triggered for branch pushes and pull requests, not tag pushes, and publication does not depend on its status for the exact release commit. Compilation during image build is useful but does not establish runtime readiness.

Any tag without a dash is allowed to update `latest`. There is no semantic-version monotonicity check or publication concurrency control. A manual rerun for an older stable release, or an older build completing after a newer one, can repoint `latest` backwards. The workflow also does not verify that the selected tag equals `package.json.version`, which is the version reported to update discovery.

These are verified omissions in the checked-in workflow. External branch/tag protections, package protections and historical CI outcomes were not inspected, so this is not a claim that an untested or older image has actually been published.

**Recommendation and acceptance:** Require checks for the exact release commit and a smoke test of the built artifact before promoting its digest to public channels. Validate tag/version consistency. Serialize promotions and reject accidental backwards movement while allowing an explicit rollback policy. Test old-tag reruns and out-of-order completion. Docker provides a test-before-push workflow pattern. [Docker release validation](https://docs.docker.com/build/ci/github-actions/test-before-push/).

### U08 - P2: Artifact origin is not verified by the updater

**Evidence:** `.github/workflows/release.yml:41-116`; `docker/Dockerfile:7,27,75`; `install.sh:709-713`; `extra/update-dockge.ts:93-105`.

The updater trusts the downloaded tag without validating a publisher/build identity policy or recording the expected release digest. Release actions use movable version tags rather than full commit SHAs. No explicit signed attestation generation/verification path or SBOM setting is present in the repository's release workflow.

This does **not** mean the images have no provenance: Docker's build-push action can attach BuildKit provenance by default. Default provenance metadata, authenticated publisher identity and verification by the consumer are distinct properties. The contents of published images were not inspected in this audit.

**Recommendation and acceptance:** Pin release-workflow actions to verified commit SHAs with an update process; emit an SBOM and verifiable build provenance; validate an expected repository/workflow identity when consuming releases. Record the resolved digest without removing the user's `latest` update channel. Reject an artifact with the wrong identity or digest before recreation. [GitHub secure use](https://docs.github.com/en/actions/reference/security/secure-use), [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), [Docker attestation defaults](https://docs.docker.com/build/ci/github-actions/attestations/).

### U09 - P2: Updates have no shared lock or atomic configuration commit

**Evidence:** `install.sh:175-189,507-568,607-619,704-773`; `extra/update-dockge.ts:182-216`.

Neither entry point acquires an installation-level update lock. `.env` is replaced by `cat "$tmp" > "$ENV_FILE"`, which truncates the destination before rewriting it. Cleanup covers an incomplete clone, not an interrupted environment rewrite or deployment operation. Validation precedes the installer changing `DOCKGE_IMAGE`.

**Impact:** Concurrent invocations can interleave Git changes, tag rotation, `.env` writes and container recreation. A process interruption or write failure can leave partial configuration. These are code-established failure windows; a power-loss or concurrency corruption experiment was not performed.

**Recommendation and acceptance:** Use one lock shared by both entry points, stage a complete candidate configuration, validate it and commit it with an atomic replacement on the same filesystem. Keep a durable operation record and original configuration for recovery. Fault-inject during the write and run both entry points concurrently; one must stop before mutations, and the destination must remain a complete old or complete new file.

### U10 - P2: The npm updater hides the command's actionable error

**Evidence:** `extra/update-dockge.ts:203-225`; `backend/child-process.ts:185-209`.

The process wrapper retains stderr in its rejected error, but the updater prints only `Error.message`. On success it prints captured stdout only. Docker progress and useful errors usually arrive on stderr.

**Reproduction:** Execute the real TypeScript entry point against temporary `git` and `docker` stubs. A pull emitted `AUDIT: registry authentication failed` on stderr and exited 1. The updater returned 1 but printed only `Process exited with code 1`; the diagnostic was lost.

**Recommendation and acceptance:** Report the failed phase, exit/signal/timeout reason and a bounded, credential-redacted diagnostic. Preserve live progress or periodic activity during long operations. The injected authentication failure must remain visible while credentials and tokens stay redacted.

## Practices already applied well

| Practice | Assessment and evidence |
| --- | --- |
| Separate discovery from installation | Implemented. UI cannot call an arbitrary shell/Git update event; `checkForUpdates` checks login and administrator role (`backend/socket-handlers/main-socket-handler.ts:68-85`). |
| Opt-in background network requests | Implemented. The setting must be boolean `true`; a manual check does not enable future checks. |
| Bounded and cancellable discovery | Implemented. Ten-second abort deadline, in-flight request sharing and shutdown checks before/after asynchronous settings reads. Current tests cover stopping during the settings read. |
| Version/channel filtering | Implemented for discovery. Drafts/invalid tags are ignored and versions are compared semantically. This does not bind installation to the discovered version. |
| Preserve local Git work | Fast-forward-only updates; npm refuses a dirty tree. Installer allows the operator to continue with edits, while Git still rejects conflicting fast-forwards. No automatic reset/clean/stash is executed. |
| Keep application data out of image replacement | Bind mounts and no volume deletion in the update command sequences. Migration rollback remains a separate concern. |
| Prefer downloaded artifacts | Implemented for the standard installer path; useful on low-memory hosts. Pull-failure fallback needs correction. |
| Validate before recreation | Both paths run Compose validation and wait for running/healthy state. File selection and the healthcheck contract need correction. |
| Distinguish stable/prerelease publication | Dash-containing release tags do not move `latest`; nightly publication is explicit. Monotonic promotion and version validation remain missing. |
| Reduce publisher credential exposure | Top-level workflow permissions are empty, job permissions are explicit, checkout does not persist credentials, and GHCR uses the built-in token. |

## Verification and limits

Local evidence lives under `output/self-update-audit-2026-09-22/`, which is ignored by Git. This report contains the durable findings; the following files retain the exact experimental output for this workspace.

| Check | Result | Evidence |
| --- | --- | --- |
| `npm run check` | Lint completed with 0 errors and one existing blank-line warning in `CreateStackSheet.vue:1048`; TypeScript and Vue checks passed. Full test phase did not complete and was interrupted. No full coverage result is claimed. | `check.log` |
| Updater/version-discovery/notice tests | 22 individual tests passed: 6 updater, 13 version checker, 3 notice tests. Also executed together through `node --test`, which reported the three test files passing. | `update-command-tests.log`, `version-check-tests.log`, `update-notice-tests.log`, `update-tests.log` |
| `npm run test:install` | 126 checks passed, 0 failed, against the repository's Docker stub and local Git fixture. | `install-tests.log` |
| Bash syntax and updater dry run | Passed; dry run executed no update commands. | `update-dry-run.log`; `bash -n install.sh test/install/run.sh` |
| HTTP healthcheck fault injection | 404/500/503 accepted as healthy by unchanged probe source. | `probe.py`, `probes.json` |
| Actual Compose configuration selection | Alternate `compose.yaml` selected without `-f`; production service selected with `-f`. No container started. | `probes.json` |
| Installer fault injection | Configured source overwritten; failed default pull caused a build; repeated update removed the prior rollback tag. | `installer-probe.log`, `probe.py` |
| CLI diagnostic failure | Actual updater discarded simulated registry stderr. | `npm-error-probe.json` |

Environment: Node 22.23.2, Docker Compose v5.5.1, Go 1.26.0. Listening-socket creation was denied with `EPERM`; consequently no real HTTP listener could be started, and no browser acceptance test or end-to-end live-container update was attempted. The first full-suite test file uses a local HTTP listener; its isolated bounded run reproduced `listen EPERM: operation not permitted 127.0.0.1` and reached the 12-second timeout, recorded in `socket-test-limit.log`. A diagnostic attempt to use `--test-isolation=none` was rejected by this Node version; the subsequent direct-file runs above produced all 22 individual test results.

The installer stub validates orchestration and file effects, not Docker daemon behavior. Published image manifests, anonymous registry access, signatures, repository protection settings and real amd64/arm64 upgrade/restore paths remain unverified. The frontend was not rebuilt because this audit changed documentation only.

## Additional observations

- Discovery reads only the first 20 GitHub releases. There is no pagination or conditional request cache. A long run of prereleases can hide an older stable release outside that page. This was identified statically, not reproduced against the live repository.
- The UI's retained last successful version has no freshness timestamp. A background check failure can leave an older result visible. Manual check failure is distinguished correctly.
- `README.md:291-292,365-366` and installer diagnostics treat the healthcheck start period as a fixed delay before checking. Docker defines a startup grace period, and modern Engines support probes at `start-interval` during it. A 180-second deadline is a policy choice; the documented timing explanation is inaccurate. [Docker HEALTHCHECK timing](https://docs.docker.com/reference/dockerfile/#healthcheck).
- Legacy npm image-publication scripts still request `linux/arm/v7`, while the release workflow explicitly limits the current Node-based image to amd64/arm64. This second publishing path should be reconciled with the workflow before it is used; it was not executed.

## Recommended order of correction

1. Correct health acceptance, preserve the selected image/channel and stop registry-update fallback on pull failure.
2. Unify the two update entry points around explicit deployment identity, immutable rollback capture, no-op detection and a shared lock.
3. Establish a tested database/configuration recovery contract and preserve useful command diagnostics.
4. Gate release promotion on the exact tested artifact; add monotonic channel promotion and consumer-verifiable provenance.

Completion should be demonstrated by the failure cases above plus an isolated real-container upgrade and restore using representative persistent data. Passing the existing tests alone does not cover these guarantees.
