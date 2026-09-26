# Updating from the web interface: state machines

How updating the panel from Settings -> About works inside: the invariants, the updater's
`--progress json` contract, the server observer and the page statechart. Implemented in 0.0.14; the
decision is the master plan entry of 2026-09-25, the shared contract is `common/panel-update.ts`,
and the operator's view is [Verified self-updates](self-updates.md#updates-started-from-the-web-interface).

The owner presses "Update" in Settings -> About. The page that is already loaded stays on screen
while the panel behind it is replaced, follows the update step by step, and ends on one honest
result: the new version, "not installed, nothing changed", "not installed, rolled back to X", or
"needs attention on the host" with the exact command.

## 1. Invariants

Every transition below is checked against them, and the tests in section 9 assert them over
generated event sequences.

- **I1 - No unconfirmed success.** The page shows "Updated" only when the updater's result for
  *this* request is `success` **and** the panel answering the page reports the target version.
  A reconnect alone, a new version alone, or a helper that exited 0 without a result line is not
  success.
- **I2 - Every state has an exit.** A state that waits for the server has a deadline. After it the
  page keeps retrying and shows what the owner can do on the host, with the real installation path.
- **I3 - Nothing changes before confirmation; cancel only while the image is being fetched.** Preview
  is a dry run. Cancel is offered while the furthest phase seen is before `downloaded`.
- **I4 - The server holds no update state in memory.** Any panel that answers - the old one, the new
  one, the old one again after recovery - rebuilds the status from the helper containers.
- **I5 - The status contract survives the version change.** `PanelUpdateStatus` has `schema: 1`, is
  only ever extended, and an unknown phase or outcome reads as "step unknown" or "unknown".
- **I6 - Stacks are not touched**, and the page says so while the panel is offline.
- **I7 - Nothing secret leaves the host.** The updater redacts errors; only owners receive the
  installation path and the error texts.

## 2. Participants

```text
 browser                     panel container            helper container          host
 +-------------------+       +------------------+       +------------------+      +----------------------+
 | page (old build)  |<----->| panel (old)      |       | runs             |      | <dir>/.dockge2/      |
 | root statechart   |  io   |  observer        |------>| .dockge2/update  |----->|   operation.json     |
 | sessionStorage    |       |  derives status  | start |  --progress json |      |   operations/<id>/   |
 +-------------------+       +------------------+ read  +------------------+      +----------------------+
          ^                  | panel (new)      |  logs          |
          +------------------|  same observer   |<---------------+ docker compose stop/up via the socket
                             +------------------+
```

- **Page**: the SPA already in memory. The statechart lives in the root of the application (a mixin
  next to `socketIO`), not on the About screen, which unmounts on `needAuth` and on navigation. It
  is a pure reducer; effects (emit, persist, reload, timers) are returned, not performed.
- **Panel**: finds its own container, starts helpers, follows their output, pushes a status. It never
  runs Compose on itself.
- **Helper**: a one-shot container from the panel's own image (docker CLI and compose plugin inside),
  outside the Compose project, `--restart no`, not removed on exit so its exit code and output
  survive the panel restart.
- **Updater**: decides everything it decides today. Section 3 lists what it gains.

## 3. Updater contract

### Invocation

Built by the panel as an argument array, never through a shell. The only browser input is the
version: `PANEL_VERSION_PATTERN` and equal to the target of a fresh preview.

```text
docker run -d --name dockge2-update-<project>-<kind> --restart no
  --log-driver json-file --log-opt max-size=1m
  --label io.dockge2.update.request=<request id from the page>
  --label io.dockge2.update.kind=preview|apply|status
  --label io.dockge2.update.installation=<dir>
  --label io.dockge2.update.from=<running version> --label io.dockge2.update.to=<version>
  --label io.dockge2.update.started=<ISO time>
  -v <dir>:<dir>:ro -v <dir>/.dockge2:<dir>/.dockge2[:ro for status]
  -v <dataDir>:<dataDir>:ro -v /tmp:/tmp -v /var/run/docker.sock:/var/run/docker.sock
  --entrypoint <dir>/.dockge2/update  <panel image id>
  --progress json  --version <v> --dry-run                                  (preview)
  --progress json  --version <v> --yes --restore-on-failed-start            (apply)
  --progress json  --status                                                 (status)
```

- `<dir>` is the `com.docker.compose.project.working_dir` label of the panel's own container, the
  label the updater checks itself; `<project>` its `com.docker.compose.project` label, checked
  against `^[a-z0-9][a-z0-9_-]*$`; `<dataDir>` the host source of the panel's `/app/data` bind.
- **Read-only everywhere except `.dockge2`.** The updater writes only there and in `/tmp`; `.env`
  and the data are read. `otherWriters` skips read-only binds, so it needs no exception for the
  helper, and the helper cannot damage the data. A data directory under `/tmp` collides with the
  writable `/tmp` bind and is refused by `otherWriters` with its own reason.
- **Fixed names.** `docker run --name` refuses a second helper of the same kind atomically; the
  request id lives in a label. A finished apply helper blocks the next apply until it is dismissed,
  so a result is always seen.
- **Log driver** is fixed to `json-file`: with `none`, `syslog` or `gelf` `docker logs` returns
  nothing and the status would be lost.
- Host `/tmp` carries the project lock and the staging directory, so a helper and an updater
  started on the host exclude each other.

### What the updater gains

1. **`--progress json`**: JSON lines on stdout, human text on stderr. One `phase` line per journal
   phase, recovery phases included; a `preview` line on a dry run; with `--status` a `journal` line;
   and exactly one `result` line on **every** exit path, including failures to write the journal and
   refusals before an operation id exists. A no-change run prints `outcome: "no-change"` although
   the journal says `success`.
2. **`--restore-on-failed-start`**: when the target started and did not become ready, the schema
   changed, and the stopped-data snapshot is verified, the updater restores the snapshot and brings
   the previous version back instead of stopping at `recovery-required`. The schema hash includes
   the dependency code of `package-lock.json`, so the schema changes in almost every release and
   without this "rolled back to a stable state" would almost never hold. The data the failed target
   left is kept aside, never deleted. The restore runs in a nested container, like `checkSnapshot`,
   with the data directory's parent writable and the snapshot read-only, so the helper itself stays
   read-only on the data; the explicit `--rollback --restore-data` uses the same code.
   After the review of 2026-09-26 (master plan): a failed or timed-out restore removes its
   container by name on its own deadline, and an unconfirmed removal leaves the journal on
   `rolling-back`; `--resume` refuses an operation whose restore began, since the restore markers
   belong to the operation id and a second target run would migrate the restored data again.
3. **Persistent Cosign trust root** under `<dir>/.dockge2`, so it is not fetched on every run.

### Lines

```json
{"dockge2":"phase","v":1,"op":"20261001T101500.000000000","phase":"downloaded","from":"0.0.14","to":"0.0.15","at":"2026-10-01T10:15:40Z"}
{"dockge2":"preview","v":1,"from":"0.0.14","to":"0.0.15","channel":"ghcr.io/mazixs/dockge2:latest","fields":["image"],"schemaChanges":true}
{"dockge2":"result","v":1,"op":"20261001T101500.000000000","outcome":"recovered","phase":"recovered","from":"0.0.14","to":"0.0.15","error":"target image is not running and healthy","restoredData":true}
{"dockge2":"journal","v":1,"op":"20261001T101500.000000000","phase":"starting-target","from":"0.0.14","to":"0.0.15"}
{"dockge2":"journal","v":1,"op":"20261001T101500.000000000","phase":"recovered","from":"0.0.14","to":"0.0.15","restoredData":true}
```

A `recovered` journal line carries `restoredData`, true or false; a line of an older updater
without it leaves the fact unknown, and the page then claims neither "restored" nor "not touched".

`outcome` is one of `previewed`, `success`, `no-change`, `refused`, `failed-before-cutover`,
`recovered`, `recovery-required`. Successful outcomes exit 0, the others do not.

### Phases

| Phase | Written when | Panel | Cancel | Page state |
| --- | --- | --- | --- | --- |
| (none yet) | helper started, verifying the release | old runs | yes | `Running.Preparing.Starting` |
| `prepared` | operation recorded, image pull | old runs | yes | `Running.Preparing.Downloading` |
| `downloaded` | image checked; seconds before stopping | old runs | no | `Running.Preparing.Ready` |
| `stopping` | old panel stopping | going down | no | `Running.Cutover.Stopping` |
| `backing-up` | stopped data copied and verified | down | no | `Running.Cutover.Snapshot` |
| `starting-target` | `compose up --wait`, up to 180 s | down, then starting | no | `Running.Cutover.Starting` |
| `checking-target` | target healthy, version and healthcheck, 10 s | new runs | no | `Running.Verifying` |
| `rolling-back` | target not ready: previous deployment (and data) coming back | down, then old | no | `Running.RollingBack` |
| `success` | final | new runs | - | `Outcome.Updated` |
| `failed-before-cutover` | final | old runs | - | `Outcome.NotChanged` |
| `recovered` | final, data restored if the schema changed | old runs again | - | `Outcome.RolledBack` |
| `recovery-required` | final | usually none | - | `Outcome.RecoveryRequired` |

Phases only move forward (`phaseRank`); a late status never moves the screen backwards.

## 4. Server observer

Stateless per I4: every status is derived from Docker.

- **Discovery** at startup: the own container through `docker inspect` of the hostname, then the
  installation directory, project, image id and data directory. Not in a container, or no label:
  `managed: "no"` with the reason. Cached for the process.
- **Following**: while a helper of this installation runs, the panel follows its `docker logs -f`
  stdout, parses lines with `parsePanelUpdateLine` and pushes `panelUpdateStatus` on each new one. A
  panel that starts inspects the helpers of its installation once and follows a running one.
- **Derivation**: `derivePanelUpdateOperation(helper, lines, ownVersion, journal?)`, fail closed.
  When an apply helper exited without a result line, the panel first runs a `status` helper and
  passes its `journal` line, so "unknown" becomes "stopped at `starting-target`" where the journal
  allows. The journal counts only when it belongs to that helper: the same `from` and `to`, and the
  same operation id, or, for a helper killed before its first line, an operation that began after
  the helper started. The journal of an earlier update is never read as this one's result.
- **Start failures**: `docker run` exit 126/127 or an entrypoint that cannot run means the updater
  is missing: `refused` with `updater-missing`, and `managed: "no"` with the same reason. Exit 2
  with nothing on stdout is an installed updater older than `--progress json` (Go's flag parser
  rejects the flag before printing): `refused` with `updater-outdated`, and the page shows the host
  commands, since one update from the host installs an updater that speaks the contract. A fixed
  name held by a container that is not a helper of this installation is `name-taken`, with the
  command that finds it; the panel never removes it. A `docker run` that fails after creating the
  container removes it only if it never started, and one that starts during that cleanup is
  followed as started.
- **Cancel**: `docker kill --signal TERM`, only if `canCancelPanelUpdate(furthest phase)` holds when
  the kill is sent. The updater turns SIGTERM before `stopping` into `failed-before-cutover`; a lost
  race ends in its recovery path and is reported as such. A helper is **never** stopped with
  `docker stop` or removed while running: SIGKILL after 10 s would kill the updater in the middle of
  its recovery.
- **Dismiss** removes a finished helper and is refused for a running one.
- **Acknowledgements**: `panelUpdatePreview` and `panelUpdateApply` answer only after `docker run -d`
  returned the container id, so a lost acknowledgement means "the helper exists or it does not", and
  a status requested after reconnecting says which.

### Events

| Event | Who | Arguments | Effect |
| --- | --- | --- | --- |
| `panelUpdateStatus` | any signed-in user | - | the status; owners also get `installDir` and error texts |
| `panelUpdatePreview` | owner | `requestId`, `version` | refused while an apply helper runs; removes a finished preview helper, starts a new one |
| `panelUpdateApply` | owner | `requestId`, `previewRequestId`, `version`, `password` | `doubleCheckPassword`; the preview helper with that request id finished `previewed` less than `PANEL_UPDATE_PREVIEW_TTL_MS` ago with `to` = `version`; no apply helper exists; then starts the apply helper |
| `panelUpdateCancel` | owner | `requestId` | the cancel rule above |
| `panelUpdateDismiss` | owner | `requestId` | removes the finished helper of that request |

Every acknowledgement is `PanelUpdateAck`: the status right after the action, or a `PanelUpdateErrorCode`. The helper mounts use `--mount type=bind`, which refuses a missing source instead of creating it, so a missing `<dir>/.dockge2` is `updater-missing` and nothing appears in the user's directory. The apply helper consumes its preview: the preview helper is removed once the apply helper started.

The status is pushed to every signed-in socket when it changes, so other users see a banner rather
than an unexplained disconnect. None of these events is an agent event, none is in the operator or
agent allowlists, and there is no MCP tool; a test keeps it so.

## 5. Page: root placement and suppressions

- The overlay that shows a running update lives in `Layout.vue` above `main` and in the main chunk,
  with everything it needs. The About screen only starts the preview and confirms with the password.
- While `Running` the page suppresses:
  - the generic "Lost connection to the socket server" banner;
  - the reload on `info.version` changing and the unconditional reload on the `refresh` event
    (`frontend/src/mixins/socket.ts`); the page reloads itself only on entering `Outcome.Updated`;
  - navigation away for the owner who runs it;
  - `vite:preloadError` reloads: ignored while `Running`, since a reload with the panel down lands on
    the browser's error page. Outside an update a preload error reloads the page, so a stale tab of
    any user recovers from a missing chunk.
- The operation is kept in `sessionStorage` (`dockge2.panelUpdate.v1`: request id, from, to, furthest
  phase, start time), read and written in `try`/`catch`. Without storage the server status alone
  drives the machine.

## 6. Page statechart

```text
PanelUpdate
|
+-- Idle
|   +-- Loading                 status requested, with a timeout
|   +-- Manual(reason)          not in a container / not managed / not supported: host commands
|   +-- Current
|   +-- Available(version)
|
+-- Preview                     nothing changed yet; close returns to Idle
|   +-- Checking(request)       dry-run helper running, no page timeout while it runs
|   +-- Ready(preview, expires) versions, fields that change, schema change warning;
|   |                           the password dialog is a flag of this state
|   +-- Refused(reason)
|
+-- Running(request, from, to)          suppressions of section 5 active
|   |
|   |   region Progress                           region Link
|   +-- Submitting        apply sent, no status   +-- Online
|   +-- Preparing                                 +-- NeedAuth    the new panel asks to sign in
|   |   +-- Starting      no phase line yet       +-- Offline
|   |   +-- Downloading   prepared                    +-- Waiting(since)
|   |   +-- Ready         downloaded                  +-- Overdue(since)   still retrying
|   +-- Cancelling        cancel sent
|   +-- Cutover
|   |   +-- Stopping
|   |   +-- Snapshot
|   |   +-- Starting
|   +-- Verifying         new panel answers, updater still watching its health
|   +-- RollingBack       target not ready, the previous version is coming back
|
+-- Outcome(request, from, to, result)
    +-- Updated
    |   +-- Reloading         result in sessionStorage, page reloads
    |   +-- Shown             after the reload, confirmed by the status again
    +-- NotChanged            refused, failed before cutover, cancelled, no change
    +-- RolledBack            recovered: the previous version answers
    +-- RecoveryRequired      host commands: --status, --rollback --restore-data
    +-- Unknown               host commands: --status, --resume, --rollback
```

`Running` has two orthogonal regions; the screen shows their combination. `Cutover x Offline` is the
expected "the panel is restarting, your stacks keep running"; `Preparing x Offline` is "the
connection dropped, the update continues on the server"; `Verifying x NeedAuth` is "the new version
asks you to sign in again; the update is being checked". One reducer with a separate `link` field.

### Events

| Event | Source |
| --- | --- |
| `BOOT(persisted?)` | page load, with the `sessionStorage` record if any |
| `STATUS(s, solicited)` | push, or the answer to the page's own request (`solicited`) |
| `LINK_UP`, `LINK_DOWN`, `AUTH_LOST` | `authIdentity` (the socket is signed in; stacks may still be loading); `disconnect`; `needAuth` |
| `ACK(kind, ok / error(code) / lost)` | acknowledgements of status, preview, apply, cancel, dismiss |
| `TICK(now)` | one-second timer while any deadline is armed |
| `CHECK`, `CONFIRM`, `SUBMIT(password)`, `CANCEL`, `DISMISS`, `CLOSE` | the owner |

### Guards

- `ours(s)`: `s.operation.requestId === ctx.request`. The request id is the only identity.
- `advance(s)`: `phaseRank(s.phase) >= phaseRank(ctx.phase)`.
- `confirmedUpdated(s)`: `ours(s)`, `!s.operation.running`, result `success`, and
  `s.panel.version === ctx.to` (I1).

### Transitions

| # | From | Event | Guard | To | Effects |
| --- | --- | --- | --- | --- | --- |
| 1 | `Idle.Loading` | `STATUS` | no operation | `Idle.Available` / `Current` / `Manual` | - |
| 2 | `Idle.Loading` | `ACK(status, lost)` or `TICK` past 15 s | - | `Idle.Manual(unsupported)` | - |
| 3 | `Idle.*` | `STATUS` | apply operation running | `Running.<phase>` as observer | persist |
| 4 | `Idle.*` | `STATUS` | apply operation finished | `Outcome.<result>` | - |
| 5 | `Idle.Available` | `CHECK` | owner, managed | `Preview.Checking` | new request id, emit preview |
| 6 | `Preview.Checking` | `STATUS` | `ours`, finished, `previewed` | `Preview.Ready` | expires = finish + 10 min |
| 7 | `Preview.Checking` | `STATUS` / `ACK error` | `ours`, finished otherwise, or refused | `Preview.Refused` | - |
| 8 | `Preview.Checking` | `STATUS(solicited)` | no operation with the request | `Preview.Refused(lost)` | - |
| 9 | `Preview.Ready` | `TICK` | expired | `Idle.Available`, "check again" | - |
| 10 | `Preview.Ready` | `CONFIRM` / `CLOSE` | - | same state, dialog open / closed | - |
| 11 | `Preview.Ready` | `SUBMIT(password)` | dialog open | `Running.Submitting` | new request id, persist, emit apply |
| 12 | `Running.Submitting` | `ACK error(password / busy / stale preview)` | - | `Preview.Ready` / `Preview.Refused` | clear persist; nothing started |
| 13 | `Running.Submitting` | `ACK lost` | - | stay | request status on `LINK_UP` |
| 14 | `Running.Submitting` | `STATUS(solicited)` after `LINK_UP` | no operation with the request | `Preview.Ready`, "the request did not reach the panel; nothing started" | clear persist |
| 15 | `Running.*` | `STATUS` | `ours`, running, `advance` | substate of the phase table | persist phase |
| 16 | `Running.*` | `STATUS` | `ours`, lower rank | stay | ignored |
| 17 | `Running.Preparing.Starting/Downloading` | `CANCEL` | owner, `canCancelPanelUpdate` | `Running.Cancelling` | emit cancel |
| 18 | `Running.Cancelling` | `ACK error(too late)` or `STATUS` with phase `downloaded` or later | - | the substate of the phase | "too late to cancel" |
| 19 | `Running.*` | `STATUS` | `confirmedUpdated` | `Outcome.Updated.Reloading` | persist result, reload |
| 20 | `Running.*` | `STATUS` | `ours`, finished, any other result | `Outcome.<result>` | persist result |
| 21 | `Running.*` except `Submitting` | `STATUS(solicited)` after `LINK_UP` | no operation with the request | `Outcome.Unknown` (helper removed) | - |
| 22 | Link `Online` | `LINK_DOWN` | - | `Offline.Waiting(now)` | - |
| 23 | Link `Offline.Waiting` | `TICK` | past the deadline of the Progress state | `Offline.Overdue` | host `--status` command |
| 24 | Link `Offline.*` / `NeedAuth` | `LINK_UP` | - | `Online` | request status |
| 25 | Link any | `AUTH_LOST` | - | `NeedAuth` | the sign-in dialog opens above the overlay |
| 26 | - | `BOOT(persisted Running)` | - | `Running.<furthest phase>`, `Offline.Waiting` | request status on `LINK_UP` |
| 27 | - | `BOOT(persisted Updated)` | - | `Outcome.Updated.Shown`, pending | request status |
| 28 | `Outcome.Updated.Shown` pending | `STATUS` | `confirmedUpdated` still holds | `Outcome.Updated.Shown` | "Updated to X" |
| 29 | `Outcome.Updated.Shown` pending | `STATUS` | contradicts | the result the status gives, or `Unknown` | - |
| 30 | `Outcome.*` | `DISMISS` | owner | `Idle.Loading` | emit dismiss, clear persist |
| 31 | `Outcome.Updated.Reloading` | `TICK` | no reload after 5 s | stay | show a "Reload" button |

Transitions 8, 14 and 21 act only on the answer to the page's own status request after reconnecting,
never on a push, which may have been sent before `docker run` returned. Anything not listed is
ignored, and logged in development builds.

Refinements made while implementing and after the review (`frontend/src/panel-update-machine.ts`):

- `Submitting` whose own request never appeared follows an apply of another request that the status
  shows running, as an observer: the panel admits one update, so that one is the update that runs.
- `Outcome.Updated.Shown` pending is confirmed by row 28, or, when the helper was already dismissed
  from another session, by a solicited status with no apply operation and the panel on the target
  version. Anything else is `Unknown(contradiction)`. It is reached only after row 19 held once.
- While online the page asks for the status again when a deadline passes without news, and marks
  the state `quiet` with the host `--status` command instead of changing it.
- Only one apply helper exists at a time, so another request's apply that runs means the one the
  page followed ended and was dismissed. A running node whose own request is gone, and a result
  still on screen, follow that apply as an observer instead of reading it as `Unknown`.
- `Outcome.Updated.Shown` pending asks again after `PANEL_UPDATE_LOADING_MS` without an answer,
  so a lost acknowledgement after the reload does not leave it pending for ever.
- `BOOT` carries the build of the page. A page of the old build that finds a successful update from
  `Idle` - it slept through the update, or was opened on a cached copy - saves the result and
  reloads once, like a followed update, instead of showing "Updated" while it still runs the
  old code.
- `DISMISS` and `CLOSE` do nothing while the page reloads: the screen offers neither, and closing
  would drop the record the new build shows.
- `LINK_UP` fires on `authIdentity`, not after the stacks loaded: a panel that restarts slowly must
  not keep a followed update offline behind an inert page.
- `Preview.Checking` waits on the clock once its acknowledgement arrived (before it a status may not
  show the helper yet, and the root bounds the acknowledgement): after `PANEL_UPDATE_CHECK_QUIET_MS`
  online without news it asks for the status as a probe and marks itself `quiet`, which About shows
  as "taking longer than usual". An answer without the helper is row 8; an unreadable answer keeps
  it checking until the next deadline. News of the running check and `LINK_UP` move the deadline.

### Deadlines of the Link region

| Progress state while offline | `Waiting` becomes `Overdue` after | Meaning shown |
| --- | --- | --- |
| `Submitting` | 1 min | "The panel does not answer; the request may not have arrived" |
| `Preparing.*`, `Cancelling` | 2 min | "Connection lost; the update continues on the server" |
| `Cutover.*` | 10 min | "The panel is restarting. Your stacks keep running" |
| `Verifying` | 3 min | "The new version started; waiting for it to answer" |
| `RollingBack` | 10 min | "The new version did not start; the previous one is coming back" |

`Overdue` is never final: the socket keeps reconnecting and the first status moves the machine on.

### What the screen shows

A step list - Check, Download, Stop, Save data, Start, Verify - with done, current and pending marks,
the elapsed time and one line for the current state. `Cancel` in `Preparing.Starting` and
`Preparing.Downloading`, nothing in `Cutover` and `Verifying`, `Close` in every outcome, `Reload` if
the automatic reload stalls. Every outcome except `Updated` names the reason and, for
`RecoveryRequired` and `Unknown`, the host commands with `sudo` and the real `<dir>`. The overlay
warns not to reload the page while the panel is offline.

Other signed-in users get a banner "The panel is being updated to X" with no controls until the
result, and reload on it rather than on the first new version they see.

## 7. Scenarios

1. **Happy path.** `CHECK` -> `Preview.Ready` -> password -> `Submitting` -> `Preparing.Starting` ->
   `Downloading` -> `Ready` -> `Cutover.Stopping`, socket drops as expected -> the new panel answers
   during `checking-target` -> `Verifying` -> `result success`, version = target ->
   `Updated.Reloading` -> reload -> `Updated.Shown`.
2. **Signature or lock fails.** `Submitting` -> `result refused` -> `NotChanged`, reason shown.
3. **Target unhealthy.** ... `Cutover.Starting` offline -> the old panel answers -> `recovered`,
   with `restoredData` when the schema changed -> `RolledBack`: "not installed, Dockge2 0.0.14 runs
   again", reason shown.
4. **Recovery itself fails.** No panel answers -> `Offline.Overdue` with `--status` and
   `--rollback --restore-data` for the host.
5. **Network blip during the download.** `Preparing x Offline.Waiting`, the helper continues; the
   status after reconnecting moves the machine to wherever the updater is.
6. **Apply acknowledgement lost.** `Submitting` stays; the solicited status after reconnecting either
   shows the helper (its phase) or not ("nothing started").
7. **Tab reloaded while the panel is down.** The browser shows its own error page. A later reload
   resumes the machine from `sessionStorage`.
8. **Second owner opens the panel mid-update.** Transition 3: observer, same overlay, cancel allowed
   while the image is still being fetched.
9. **Docker daemon restarted, helper killed.** No result line: the status helper reads the journal;
   `Unknown` with the phase it stopped on and `--resume` / `--rollback`.
10. **Update started on the host at the same time.** The updater lock refuses the helper: `refused`,
    "another update owns this Docker project".
11. **Unfinished operation from an earlier failure.** The dry run is refused with the reason and the
    host recovery command.
12. **The new panel does not accept the old session.** `Verifying x NeedAuth`: sign in again, then
    the solicited status confirms the result.

## 8. Decisions on the review questions

- **Q1 - automatic data restore when the target never became ready: yes, in 0.0.14,** as described
  in section 3. Without it the promise of a rollback fails in almost every release.
- **Q2 - cancel: SIGTERM, only before `downloaded`.** No cancel file in the updater.
- **Q3 - no service worker.** A warning on the overlay, `sessionStorage` and `BOOT` suffice.
- **Q4 - agents: not now.** Each panel updates itself; the events stay out of every agent allowlist.
- **Q5 - host `/tmp` stays**, since the installed updater decides where its lock lives. `/run/lock`
  is the better place when the updater next changes that contract.

## 9. Tests

- **Reducer, table driven**: every row of section 6, including the negative ones (late phase, foreign
  request, success with another version, contradiction after reload, push instead of solicited).
- **Model check**: every sequence of five events, then 3000 seeded random sequences of seven, from
  each of eight seeds (boot with each kind of saved record, and the owner's path up to `SUBMIT` and
  `CHECK`, which is seven events long by itself); the full search to seven does not fit in memory. The
  alphabet is abstract (statuses of each phase and result, link up, down and auth lost, ticks past
  each deadline, acks lost and failed).
  Assert I1, I2 (every reachable non-final state has a deadline or an owner action), I3 (no cancel
  from `downloaded` on) and that the request id is never lost.
- **Contract**: `parsePanelUpdateLine` and `derivePanelUpdateOperation` over every row of section 4.
- **Observer**: argument building (read-only mounts, fixed names, log driver, no shell), start
  failures, cancel and dismiss rules, role checks, the events staying out of agent allowlists.
- **Updater (Go)**: `--progress json` prints every phase and exactly one result line on every exit
  path; `--restore-on-failed-start` restores only when the target never became ready and the
  snapshot is verified, and keeps the failed data aside.
- **Docker integration**: a fake launcher printing scripted lines with scripted exit codes; the
  observer follows it and derives the status.
- **Release gate**: through the helper on both architectures, a dry run and a same-version run
  (`no-change`) on the candidate. The first real cutover from the page is 0.0.14 -> 0.0.15 on the
  review VPS.
