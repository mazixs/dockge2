# Installer and WebUI update follow-up

Date: 2026-09-22. Baseline: `main` at `3f830768eeca540f50b1fe199b248164fbf0311b`,
with the previous self-update implementation already uncommitted. This follow-up preserves that
work. No commit, tag, image publication or production deployment was made.

## Findings and corrections

| Priority | Reproduction / original behavior | Correction and evidence |
| --- | --- | --- |
| P1 | Signal the bootstrap shell alone while its native updater is running. The shell did not explicitly forward the signal or wait for recovery before deleting the temporary verifier. | `install.sh` forwards INT/TERM and waits for the child to finish. A subprocess test signals the parent, checks that recovery can still read the verifier, and verifies the child's failure status. |
| P1 | Start another command for a stack whose terminal already exists. `Terminal.exec` rejected a string; `callbackError` did not acknowledge non-Error values, leaving WebUI waiting for a timeout. | Busy is an `OperationError` with code `busy`. Every exception category now gets an acknowledgement; unexpected non-Error values get a safe generic message. |
| P1 | Interrupt a command that handles SIGINT and exits with code zero. Compose can do this too. The numeric code alone could report success or allow the next update stage to run. | Terminal execution records interruption separately from exit status, rejects with `interrupted` and `unknown: true`, and retains its command lock until exit. A real PTY process reproduces the zero-exit case. Interactive shell reconnect behavior is preserved. |
| P2 | Update a stack containing both `image` and `build`. The initial pull also tried to download the buildable image and could fail before the intended local build. | Use `pull --ignore-buildable` when build services exist; ordinary registry failures still stop the update. Real Docker failure injection covers stack and service operations and verifies the original container and source bytes survive. |
| P2 | Pull, build and container application errors used generic text; missing Docker during validation was described as an invalid user configuration. | Stable `pull`, `build`, `apply`, `spawn`, `busy` and `interrupted` codes identify confirmed command boundaries. Validation infrastructure failures do not blame the Compose file. No registry-specific cause is guessed from free-form stderr. |
| P2 | A parsed error-looking log line could override an explicit successful acknowledgement or an unknown result. | The final acknowledgement takes precedence over log heuristics in `StackProgress.vue`; tests exercise all outcomes. |
| P2 | All release discovery failures became `updateCheckFailed`, including HTTP limits, malformed data and a channel with no complete release. | Typed discovery failures survive the checker, Socket.IO handler, server-info broadcast and About screen. Last known version and last successful timestamp remain unchanged after a failure. |
| P2 | A synchronous transport exception rejected the UI request promise, bypassing the normal acknowledgement path. | `AgentRequests` settles once with an unknown result and releases the pending request; it never retries a write automatically. |
| P2 | `--resume --version ...` silently ignored the requested source; `--status --rollback` silently selected status. | Recovery rejects conflicting operations and source changes before Docker or installation writes. |

## Error contract

The About screen checks **release availability**. It does not install the panel from the browser.
Panel installation and self-update execute on the host through the verified bootstrap/native engine.
Stack/service updates from WebUI are a separate Docker Compose operation.

Release discovery reports:

- `network`: GitHub could not be reached from the server.
- `timeout`: the complete check exceeded its deadline.
- `rateLimited`: HTTP 429 or HTTP 403 with documented rate-limit headers.
- `registry`: another HTTP failure.
- `invalidResponse`: invalid JSON/list data or the pagination bound was exhausted.
- `noRelease`: no complete release exists for the chosen channel; this is not "up to date".
- `internal`: another checker failure. Browser acknowledgement loss has a separate connection message;
  permission refusal retains the permission message.

For stack updates, pull/build failure means recreation has not begun in this operation. An apply
failure may have changed services. Interruption or a lost acknowledgement leaves the final state
unknown. A successful Compose command is not a claim that arbitrary application health checks passed.

## Verification boundaries

- Bootstrap tests control downloader/verifier command boundaries. They prove ordering, signer/issuer
  arguments, argument preservation, refusal paths and signal forwarding, **not** real cryptography.
- A real bootstrap request for `0.0.8` verifies the pinned Cosign download and then fails with HTTP 404
  for the absent native updater asset. The requested installation directory remains absent. There is
  no fallback to source checkout or build. Cosign asset HEAD: 200; updater `0.0.8` asset HEAD: 404.
- Real Docker tests use unique temporary projects and isolated databases/stack directories. They
  cover successful service update and pull/build failures without touching pre-existing stacks.
- Chromium uses the repository's fixture with injected server responses, not a live GitHub outage.
  All six actionable discovery categories and browser acknowledgement loss render their Russian
  messages. The 390 px viewport has no horizontal overflow. Screenshot:
  `output/playwright/update-check-connection-mobile.png` (local ignored artifact).
- `npm run check`: 582 passed, all coverage floors passed (88.81% lines).
- `npm run test:docker-integration`: all 12 passed. `npm run build:frontend` passed.
- `npm run test:install` passed; the final bootstrap/wrapper suite has 7 passing cases.
- Lint's existing `CreateStackSheet.vue` blank-line warning is unrelated.

Fresh installation and full panel cutover from a real **new signed release** on both architectures
remain release CI gates: the first release implementing this protocol has not been published.
The command-boundary tests and Docker stack tests do not replace those gates.

References: [Compose interruption behavior](https://docs.docker.com/reference/cli/docker/compose/up/),
[buildable image pulls](https://docs.docker.com/reference/cli/docker/compose/pull/),
[operational contract](../self-updates.md).
