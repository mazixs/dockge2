# Self-update reliability: implementation and verification

Date: 2026-09-22. Baseline: `main` at `3f830768eeca540f50b1fe199b248164fbf0311b`.
The initial uncommitted state contained only the self-update audit and reliability plan documents.
Application changes below are local and uncommitted. No image, tag, release or deployment was published.
No existing panel or managed stack container was changed.

## Implemented behavior

| Audit issue / plan area | Implementation |
| --- | --- |
| Production configuration coming from `main`; U03 | Released bootstrap, signed descriptor, fixed asset allow-list, image digest and staged vendor Compose. No branch checkout or build fallback. Explicit development refs only. |
| U02, U05 | One native Go engine behind both current entry points; explicit Compose project/directory/files, retained desired source, exact versions and mirrors. |
| U04 | Previous image comes from the actual container ID and gets a retained tag. No-op/source-only changes preserve the previous distinct deployment. |
| U09 | Project and data-path locks, durable journal, private atomic files, interrupted-operation refusal and explicit resume/recovery. Other writable container mounts and nonempty fresh data are refused. |
| U01 | Readiness after database/auth initialization, strict HTTP/JSON/version probe, exact image/platform/version checks and a 10-second stability window. |
| U06 | Free-space preflight, stop-before-copy, hashed and synced data snapshot, SQLite integrity check, preserved failed data, schema-aware recovery and explicit data restoration. Future migrations now block downgrade startup. |
| U07, U08 | Tagged-source CI gates, one candidate digest, both image architectures, signatures, SBOM/provenance, public-access checks, immutable-release reuse and monotonic stable promotion. Direct npm/nightly publication bypasses are disabled. |
| U10, discovery | Bounded command diagnostics, visible operation phases, complete-release filtering, pagination, failed/stale check states and exact-version update instructions. |
| Legacy migration | Explicit `0.0.8` vendor/schema contract checked against the running image; working tree and `.env` preserved. Old checkout entry points are not rewritten; subsequent updates use `.dockge2/update`. |

See [the operational contract](../self-updates.md), [README](../../README.md),
[the original audit](2026-09-22-self-update-audit.md) and
[the approved plan](2026-09-22-self-update-reliability-plan.md).

## Local evidence

- `npm run test:install` passed: Go race tests, health-probe response tests, release promotion/schema
  tests, bootstrap checksum rejection, argument forwarding and shell syntax checks.
- The updater tests exercise actual temporary files with command-boundary failure injection: pull
  failure, failed snapshot recovery, cancellation, wrong/tampered release data, source retention,
  successful cutover, repeated no-op, data restore with newer data preserved, schema-change refusal,
  concurrency, and process loss at each journaled cutover phase. Producer and consumer schema hashes
  are compared across the JavaScript and Go implementations.
- `go vet ./...` passed. Native updater builds passed for Linux amd64 and arm64 with CGO disabled.
  Build/cache artifacts were kept in `/tmp`.
- Direct targeted Node tests passed: readiness/database downgrade rejection (4), release discovery
  (16), update-notice states (4), server-info visibility (3), and release policy/schema identity (3).
- `npm run lint`, `npm run check-ts` and `npm run check-vue` passed. Lint retains the pre-existing
  blank-line warning in `CreateStackSheet.vue:1048`; that unrelated file was not changed.
- `npm run build:frontend` passed. Actual Docker Compose parsing passed using a temporary env file
  and a prospective installation directory, without contacting or mutating containers.
- Workflow YAML parsing, all 12 release shell blocks, installer/recovery gate shell syntax and
  `git diff --check` passed.

## Follow-up verification

The [installer and WebUI follow-up](2026-09-22-install-web-update-followup.md) records additional
confirmed defects, fixes and classification contracts. With Docker/network access available:

- `npm run check` passed all 582 tests and every coverage floor: 88.81% lines/statements,
  85.39% branches, 93.07% functions. No coverage thresholds were reduced.
- `npm run test:docker-integration` passed all 12 real Docker tests, including update pull/build
  failure injection and successful service update, in isolated temporary projects.
- `npm run test:install` passed the Go race, healthcheck and release/bootstrap contracts.
  The final bootstrap/wrapper suite passed 7 tests, including signal forwarding and offline
  delegation through `extra/update-dockge.sh`.
- `npm run build:frontend` passed. The final terminal interruption/cleanup suite passed 10 tests.
- Chromium rendered all six actionable release discovery failure messages plus browser connection
  loss. At 390 px the page has no horizontal overflow. This used injected fixture responses.
- A real `0.0.8` bootstrap request failed on the absent native updater asset without creating the
  requested installation directory or falling back to main/build.

Earlier restricted runs could not open HTTP listeners or access Docker. Those local environment
blockers are resolved; they are no longer reasons to leave full checks or Docker tests unverified.

## Open acceptance gates

The following evidence must come from an isolated permitted CI environment before release:

1. Release-workflow execution of the same full checks, plus the complete production browser E2E suite.
2. Real fresh installation, `0.0.8` upgrade/restore and, when available, upgrade from the previous
   managed release with owner login and updater self-upgrade on both architectures.
3. Real Cosign/Fulcio/transparency verification of the produced bundles, anonymous GHCR pulls,
   release-asset downloads and promotion of the exact tested digest.
4. Host-level crash/power-loss and storage-exhaustion exercises. Unit failure injection covers
   journal decisions, but does not prove filesystem/Docker/SQLite durability under every host failure.
5. Review of the generated release and migration procedure before any production cutover.

The first release with this protocol is not yet published. Current `0.0.8` assets do not implement
it. The README explicitly distinguishes the new release instructions from an already available
production installer. A green local contract suite alone does not close the plan's production gates.
