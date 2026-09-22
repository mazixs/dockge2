# Performance audit and implementation plan

Date: 2026-09-22. Baseline: `d1003358dc5c231997d64da0fad80856b829bdfc`, version 0.0.7.

Status: audit, research and proposed work only. No application changes were made for this report. The existing uncommitted change to `frontend/src/components/StabilityDashboard.vue` was present during measurements and is outside this task.

Implementation follow-up: [local changes, measurements and remaining qualification](2026-09-22-performance-results.md).
The baseline and findings below are retained as the pre-implementation record.

## Decision

Prioritize resource ownership, unnecessary background work and bounded server memory before introducing more caches. A browser navigation experiment already shows retained resources; caching more objects before resolving that retention would obscure the problem. Repeated date formatting, eager log subscriptions and duplicate server reads provide smaller, well-defined optimization opportunities.

Treat three budgets separately:

1. Browser: retained objects, DOM, terminal/editor instances, rendering, JavaScript download and responsiveness.
2. Panel server: Node RSS, Docker subprocesses, database reads, Git previews and connected clients.
3. Installation/build: peak compiler memory. Improving the interface does not by itself make an on-server frontend build fit a small machine.

Do not persist current container state as cached truth. Immutable assets and content-addressed data can be reused; mutable data needs a current observation, explicit freshness and invalidation. Sharing one in-flight read is still appropriate for mutable data.

## Scope and method

The audit traced Vue component lifecycles, Socket.IO subscriptions, periodic reads, terminal ownership, stack collection, history queries, Git previews, source metadata caches, asset delivery and the production build. External research used official documentation and source code, listed below.

Runtime measurements used a separate database, temporary stack directory and production frontend on `127.0.0.1:5101`. Fifty synthetic stack directories were created, without deploying their containers. Docker discovery could see 17 existing containers and 11 external projects; these were read only. No existing stack was started, stopped, edited or deleted. The sidebar therefore contained 61 projects. Host names, credentials and stack contents are excluded from the committed artifacts.

Environment: Node 22.23.2, Intel Core i7-11700K, 16 logical CPUs, one automated Chromium tab, one local endpoint, no CPU throttling. Browser data came from Chrome DevTools Protocol through Playwright. Measurements are exploratory samples, not a statistically established benchmark. Server history was newly initialized rather than a representative 30-day dataset.

Evidence labels:

- **Measured:** observed in this isolated runtime/build.
- **Confirmed in code:** directly established by the current source; not necessarily timed under load.
- **Hypothesis:** requires a trace, retaining path or controlled experiment before claiming a performance gain.

## Measured baseline

Machine-readable results: [performance-baseline.json](2026-09-22-performance-baseline.json).

| Scenario | Result | Interpretation and limits |
| --- | --- | --- |
| Production frontend build | 4.22 s elapsed; maximum RSS 1,190,376 KiB, about 1.14 GiB | Compiler measurement from `/usr/bin/time -v`; not panel runtime memory |
| Entry JS and its static imports | 724,138 bytes raw; 232,254 gzip; 199,994 Brotli | Does not include CSS, fonts, locale chunks or route chunks |
| Entry CSS | 327,951 bytes raw; 35,203 Brotli | Separate from the JS budget |
| Overview after GC | 10.03 MiB JS heap; 4,091 CDP DOM nodes; 163 listeners | JS heap is not total browser process memory |
| Overview idle, 15 s | 0.266 s main-thread task time; 2 received WebSocket frames containing 32,032 characters | One sample; characters are not transport bytes or a bandwidth rate |
| Overview date formatting, 11 s | 6,532 calls to `Date.prototype.toLocaleString` | Instrumented call count, not a CPU timing measurement |
| Managed stack inspector before opening logs | One xterm instance; 12.28 MiB post-GC heap | Confirms eager terminal rendering in this route |
| Return from first files visit | 13.91 MiB post-GC heap; 4,759 nodes; 250 listeners | Start of the navigation comparison |
| After 10 further inspector -> files -> overview roundtrips | 23.05 MiB; 11,219 nodes; 1,050 listeners | No visible editor or terminal on the final overview |
| After another 10 s and GC | 22.96 MiB; same nodes/listeners | Retention outlasts the immediate navigation/transitions |
| Control: 10 inspector-only roundtrips | 23.21 MiB; nodes/listeners unchanged | Localizes the reproducible growth to the files route or its dependencies |
| Ten additional files roundtrips | 29.88 MiB; 17,679 nodes; 1,850 listeners | Another 6,460 nodes and 800 listeners; visible element count stayed 2,933 |
| Node RSS samples | 184.2 MiB before login; 193.6 MiB after overview; 222.8 MiB after navigation | Process samples, not steady-state/peak limits; excludes Docker and child processes |

Navigation measurements used explicit garbage collection. Later control runs also discarded console entries to reduce profiler-induced retention. A full heap retaining-path analysis has not been completed. The observed growth must not be attributed entirely to one component without a repair-and-retest comparison.

Not measured: field INP, route latency percentiles, long-term RSS plateau, large Git preview memory, 30-day history cost, slow remote agents, constrained VPS behavior, multi-tab scaling, or production workloads. No percentage speedup or supported minimum hardware specification can be inferred from these samples.

## Existing optimizations to preserve

- Hashed `/assets` already use a one-year immutable cache, with compressed delivery. HTML is revalidated. This is not a missing-cache defect (`backend/dockge-server.ts`, `backend/routers/main-router.ts`).
- Major routes are lazy loaded; locales are loaded on demand with English as the fallback. Splitting English into a separate chunk is not automatically useful.
- Docker statistics already use `SharedReading`: one in-flight read and a 1,500 ms reuse window. Do not replace this with one Docker process per client.
- Inspector requests use generation checks and per-kind in-flight tracking; scheduled backend observation rounds avoid overlap. Extend these contracts rather than adding unrelated timers.
- Container observation runs independently of connected browsers. Closing a tab must not stop availability recording.
- Terminal disposal, log keepalive cleanup, progress observers and the CodeMirror wrapper already have cleanup paths. A blanket claim that editors or all terminals lack disposal would be incorrect.
- The production image is prebuilt, excludes development dependencies, and is pulled by the updater. This is the main existing protection for small deployment hosts.

## Findings and proposed responses

### F01. Files-route navigation retains resources - P1

**Measured:** each block of ten files-route roundtrips added 6,460 CDP nodes and 800 listeners after GC. The inspector-only control did not. This is a reproducible retention signal, not just the first lazy import increasing heap size.

**Confirmed in code:** `frontend/src/components/Confirm.vue:57` creates a Bootstrap `Modal` and never disposes it. `frontend/src/pages/Compose.vue:270` mounts this component. Installed Bootstrap stores component instances in a module-level strong `Map` (`bootstrap/js/src/dom/data.js`); `BaseComponent.dispose()` removes that entry. The dialog can retain its detached element and associated objects after unmount. Bootstrap documents the disposal lifecycle. [Bootstrap modal methods](https://getbootstrap.com/docs/5.3/components/modal/#methods)

**Plan:** repair ownership of each manually created modal, handling an open dialog and an in-progress transition. Inspect retaining paths before and after this change. Review outstanding terminal joins: `frontend/src/mixins/socket.ts:773` can register a terminal in the join callback after `unbindTerminal()` has run. That asynchronous race is a code-level candidate, not a reproduced cause of the measured growth.

**Acceptance:** after warmup, 100 files-route roundtrips have no cycle-correlated retained modal/editor/terminal instances or listener growth; late acknowledgements cannot register disposed terminals. Establish a heap plateau across repeated runs, initially allowing 5 MiB measurement variation rather than requiring identical heap sizes. Verify keyboard focus, body scroll restoration and dialog reopening.

### F02. Polling and UI clocks ignore browser visibility - P1

**Confirmed in code:** `StabilityDashboard.vue:216` requests data every 30 s and ticks a rendering clock every 5 s. `StackInspector.vue:371` schedules status at 5 s after an answer and requests Docker statistics with it; its age clock runs every second. No frontend `visibilitychange` integration was found. Browser throttling changes timer execution, but does not establish an intentional pause/resume contract.

**Plan:** use one small visibility-aware scheduling helper shared by these consumers. Pause ordinary page polling and render clocks when hidden. On return, coalesce visibility, reconnect and route events into one current read per resource. Keep server observation and running operations independent. See the state model below.

**Acceptance:** a hidden, idle page initiates no periodic status/statistics/history requests after in-flight work settles. Returning to it automatically requests fresh data once without a reload prompt or a catch-up burst. Real server observation failure still appears as unknown/error.

### F03. Logs and progress terminals are acquired before demand - P1

**Confirmed in code:** `getStack` joins a combined terminal (`backend/agent-socket-handlers/docker-socket-handler.ts:168`); `Stack.joinCombinedTerminal()` starts `docker compose logs -f --tail 100` (`backend/stack.ts:1178`). `StackInspector.vue:54` also mounts `StackProgress`, including its terminal renderer. An xterm was present before opening the logs tab. Previously opened logs and interactive terminal tabs remain mounted under `v-show`.

**Plan:** separate metadata reads, log subscriptions, operation output and interactive sessions. Subscribe to logs when requested and detach when no consumer needs them. Mount the progress terminal for an actual operation or an explicitly opened progress view. Preserve bounded output for an active command even when its view is hidden. Interactive sessions must survive ordinary tab switches according to their existing behavior; unmounting a renderer must not terminate a command.

**Acceptance:** opening an idle inspector acquires no log-follow process or xterm just to display metadata. Logs appear correctly on first open, survive reconnect with bounded history, and unsubscribe without duplicate joins. Starting an operation still shows all required output and final status.

### F04. The overview reformats and revisits unchanged history - P2

**Measured:** 6,532 locale date-format calls in 11 s with 17 container rows and 816 history buckets. **Confirmed in code:** `StabilityDashboard.vue:358` formats both boundaries of every bucket in a template-called method; the component also has a ticking clock. Every container and bucket is rendered.

**Plan:** reuse `Intl.DateTimeFormat` per locale/timezone/options and derive bucket labels once per accepted snapshot. Separate current age/uptime displays from unchanged history rows. Give immutable read DTOs shallow reactive ownership only after documenting replacement semantics. Release labels with their snapshot; do not create an unbounded timestamp-to-string cache.

**Acceptance:** an age-only tick formats no unchanged bucket boundaries. Locale, timezone, history window and snapshot changes rebuild the appropriate labels. Compare main-thread traces and heap, not call counts alone. Consider row virtualization only after measuring larger datasets; do not render each bucket as an extra Vue component.

### F05. Whole-list publication causes repeated client work - P2

**Confirmed in code:** the scheduled server round publishes full stack summaries. `frontend/src/mixins/socket.ts` replaces received lists and rebuilds `completeStackList`; `StackList.vue` filters/groups/sorts and uses index-based row keys (`:87`). An unchanged logical row can get a new object on every publication.

**Plan:** first use stable `(endpoint, stack name)` identities and preserve unchanged DTO references using an explicit field comparison or producer revision. Separate static description, observed runtime state and client selection. Avoid hashing an entire graph with `JSON.stringify` on every render. Only then assess server-side unchanged-payload suppression. A delta protocol is a later option if bandwidth measurements justify its reconnect/version complexity.

**Acceptance:** unchanged summaries do not invalidate all row components. Changed status, ordering, deletion, permissions and agent availability still update. Every reconnect starts with an authoritative full snapshot; old endpoint data cannot leak into a new selection.

### F06. Collection repeats host reads and performs per-stack work - P2

**Confirmed in code:** the 10 s scheduled round calls `observeStacks()` and then `sendStackList(true)`; both can call `Stack.getStackList()` (`backend/dockge-server.ts:858,884`). Managed-directory caching does not eliminate fresh Docker enumeration. Stability has its own runtime collection. `Stack.fillAvailability():926` starts one query per stack, and `fillStackDetails():951` starts directory/source work through an unbounded `Promise.all`.

**Plan:** build one coherent host observation per collection round and let authorized projections consume it. Keep container inspection separate where it needs fields absent from `docker ps`, but avoid repeating the same read within a round. Batch availability reads and bound filesystem/Git subprocess concurrency on a cold metadata cache. Do not pool browser-authenticated agent connections across users.

**Acceptance:** instrument actual subprocess/query counts before changing this path. A scheduled round has no duplicate equivalent Docker enumeration; additional local viewers do not multiply collection work. Record errors and observation times explicitly. Operations invalidate relevant snapshots and trigger a post-operation read; a late pre-operation response cannot overwrite it.

### F07. Git preview memory is count-bounded, not byte-bounded - P1

**Confirmed in code:** `backend/stack-git.ts:300,505` retains up to ten previews, each with before/target file buffers and public comparison data. Each tree may contain up to 20 MiB. The two trees alone permit roughly 400 MiB across ten previews, before strings and object overhead. This is a limit-derived risk, not a measured allocation peak. Expired previews are removed during a later preview creation; expiry alone does not release their memory.

**Plan:** add a global byte-accounted preview budget, active expiry cleanup and explicit release/cancel behavior. Account for both buffers and retained comparison text; cover transient construction as well as final storage with an admission/concurrency limit. Start with eviction of expired/old inactive previews and a clear rebuild response. Select the actual budget through the constrained-host test. Do not silently reduce the supported 20 MiB repository limit. Protected file-backed staging is a separate option if valid previews cannot fit safely, not a prerequisite for the first fix.

**Acceptance:** memory is released on deadline without a subsequent preview request; concurrent preview creation stays within a defined envelope. Apply after eviction/expiry returns a recoverable result. Authorization, file rechecks, preview ownership, rollback and source preservation remain enforced. Never persist secret-bearing comparisons in browser storage.

### F08. Mutable metadata and error snapshots need explicit contracts - P2

**Confirmed in code:** `backend/stack-source.ts:20,119` has a 60 s metadata map without a global entry limit or autonomous expired-entry removal. `backend/observations.ts` retains last-status entries. These deserve deletion/expiry ownership checks. `readDockerStats():957` catches failures and returns an empty map, so the shared reader can treat that value as a successful sample for its reuse window.

**Plan:** bound source metadata by entries/estimated bytes, remove entries when stacks disappear, and share pending reads per key. Revalidate mutable source status; a Git commit ID does not prove the working tree is unchanged. Return a typed unavailable/error statistics result rather than making a failed read indistinguishable from a valid empty host. Verify generation handling when invalidation occurs during an in-flight read.

**Acceptance:** stack churn cannot grow maps indefinitely. SSH file changes become visible under an explicit bounded revalidation policy. Docker errors do not appear as zero usage or healthy empty state. Concurrent callers still share one read.

### F09. History cost grows with the observation window - P2, scale-dependent

**Confirmed in code:** `backend/stability.ts:291` loads matching observation rows for the window; `common/stability.ts:95` sorts changes and walks them for each history bucket. The current experiment did not contain 30 days of history, so its cost is unmeasured.

**Plan:** benchmark realistic stable and flapping histories first. Use `EXPLAIN QUERY PLAN` before selecting indexes. Batch reads and consider a sorted interval sweep before storing permanent aggregates. Share derived results for the same snapshot revision and explicitly aligned window. Retention deletion, observation extension and changes in coverage must invalidate those results.

**Acceptance:** historical availability and unknown intervals match the existing calculation on boundary/gap/retention cases. Query time and peak allocation improve on a fixed large dataset. Closed time ranges are reusable only when their source revision is known; a past timestamp alone does not make an aggregate immutable.

### F10. Stream bounds and buffer processing need load tests - P2

**Confirmed in code:** `backend/terminal.ts:34` limits replay to 100 chunks rather than bytes. Chunk sizes vary. Progress parsing walks the xterm buffer on throttled write notifications. Existing frontend scrollback and terminal cleanup mean this is not evidence of an unlimited frontend terminal.

**Plan:** define replay limits in bytes as well as lines, batch visual writes, and parse newly received operation output incrementally where possible. Separate display backpressure from process/input handling. Explicitly indicate a truncated replay rather than silently presenting it as complete.

**Acceptance:** sustained/bursty logs have bounded retained memory and responsive navigation. Interactive input, UTF-8 boundaries, reconnect replay, command completion parsing and error visibility remain correct. Do not select arbitrary caps without measuring representative output.

### F11. Initial bundles and build memory need different remedies - P2/P3

**Measured:** entry JavaScript is about 707 KiB raw / 227 KiB gzip and entry CSS about 320 KiB raw. The existing `extra/check-bundle.ts` ceiling is 780 KiB raw / 250 KiB gzip for entry JS plus modulepreloads. It does not cover CSS, fonts or route loads. The production build reached about 1.14 GiB RSS.

**Plan:** measure the dependency graph and first-use traces before splitting further. Candidates include eager settings imports, global Bootstrap imports/styles and progress-terminal acquisition. Keep common small dependencies shared; avoid turning initial navigation into a sequential chunk waterfall. Track total route cost in addition to the existing entry budget. Preserve prebuilt image updates and make an unavailable-image build fallback explicit on constrained hosts. Evaluate precompiled backend output only if profiling establishes material `tsx` startup/runtime cost.

**Acceptance:** existing bundle ceilings are not raised to pass a check. Cold and warm inspector/files navigation remain responsive, with correct offline/chunk-error recovery. Installation on the target small host uses the published image and does not unexpectedly start the frontend compiler.

## Cache policy

Every new cache needs an owner, identity key, byte/entry budget, eviction policy, freshness rule and invalidation tests. Record hit/miss/eviction counters without sensitive values. A timeout is not a substitute for releasing expired objects.

| Data | Reuse policy | Invalidation and correctness boundary |
| --- | --- | --- |
| Hashed JS/CSS/fonts | Existing long-lived immutable HTTP cache | New content gets a new URL; HTML revalidates |
| Loaded locale catalog | Reuse the loaded module | Locale switch selects another catalog; avoid preloading all languages |
| Git blob at an exact object ID | Optional bounded server cache keyed by repository identity and object ID | Authorization on every read; repository eviction; do not use branch name as immutable identity |
| Working tree, branch HEAD, remote update status | Fresh read or explicit short observation window; deduplicate concurrent reads | External Git/SSH changes, checkout, save, update and deletion; show observation age where relevant |
| Compose/env text and editable drafts | Keep only the active editing state and required explicit drafts | No generic persistent browser cache; preserve unsaved work; reread/check source hashes before apply |
| Parsed source structure | Optional bounded derivation keyed by verified content hash and parser version | Fresh source verification first; paths/mtime alone are insufficient; release on eviction |
| Current status/CPU/memory | Shared in-flight read and explicitly timestamped short sample | Refresh after commands/reconnect; generation guards; errors remain errors; never durable cached health |
| Raw observations and history | Database is the record; bounded derived reuse by observation revision/window | Open intervals, retention and coverage changes invalidate derived values |
| Bucket labels / date formatter | Snapshot-owned labels and locale/timezone-keyed formatters | Snapshot/window/locale/timezone changes; no unbounded timestamp map |
| Git previews | Temporary transaction state with byte budget and deadline | Cancel/apply/expiry/eviction releases state; revalidate files and authority at apply |
| Log replay | Byte-bounded stream buffer, not a cache of current container state | Consumer lifecycle, process termination and retention policy; disclose truncation |
| Permissions/session data | Server remains authoritative for every operation | Logout/revocation removes client subscriptions and private projections; never serve a privileged cached projection to another principal |

A snapshot can be immutable as an object while describing mutable reality. Shallow Vue reactivity is suitable for replacing that snapshot; it does not authorize keeping its values fresh forever. Any persistent cache would add a new privacy and invalidation surface and is outside the first implementation phase.

## Refresh and visibility model

| State | Browser behavior | Server behavior |
| --- | --- | --- |
| Visible, idle | Poll only data consumed by the active page; at most one request per resource | Continue independent scheduled observations |
| Visible, command running | Receive operation progress and final result; update necessary status | Operation owns its execution; refresh observations after completion |
| Hidden, idle | Stop ordinary polling/render clocks; keep the connection if needed for session continuity | Keep recording observations; initially existing pushes may still arrive |
| Hidden, command running | Retain bounded operation state; suspend unnecessary rendering | Continue the command; do not cancel it because the document is hidden |
| Becoming visible | Coalesce focus/visibility/reconnect events; request current data once; restart schedule after resolution | Return a fresh or explicitly aged observation |
| Disconnected/reconnecting | Mark unavailable quietly; avoid concurrent retry timers | Reconnect with full authorized state; prevent retry storms |
| Fresh request reports old/failed server observation | Show a persistent, meaningful unknown/error state; retry is available | Preserve the failure and its observation time |

Distinguish a browser that intentionally paused from a server that failed to observe. Returning from an inactive tab should not briefly display a large warning and demand a page reload. While synchronizing, retain useful previous content with a subdued updating/age indication; do not relabel old readings as current. An existing real error remains visible until a successful fresh result resolves it. If the request times out, present a real recoverable failure.

Pausing client requests does not stop server pushes. Measure hidden-tab push/render cost separately. If necessary, add a visibility subscription hint to suppress nonessential full-list delivery while keeping operations, authentication and server observation intact. That protocol change follows, rather than blocks, the simpler scheduling repair.

## External practices and applicability

Sources were checked on 2026-09-22. These are concrete references, not claims that another product has the same architecture or workload.

| Source | Verified practice | Application to Dockge2 |
| --- | --- | --- |
| [Vue performance guide](https://vuejs.org/guide/best-practices/performance.html) | Stable props, shallow reactivity for large immutable structures, lazy routes and large-list virtualization | Apply to read snapshots and measured expensive rows. Keep editing state reactive; virtualization and `v-memo` are conditional tools, not blanket directives. |
| [GitLab frontend performance guide](https://docs.gitlab.com/development/fe_guide/performance/) | Visible-tab polling, shared polling behavior, component timing and reduced global JavaScript | Adopt visibility ownership and measurements. Its server-directed HTTP polling details are not directly transferable to this Socket.IO API. |
| [Grafana Scenes refresh picker source](https://github.com/grafana/scenes/blob/main/packages/scenes/src/components/SceneRefreshPicker.tsx) | Suppresses scheduled refresh while hidden and refreshes on visibility restoration when blocked | Use automatic resynchronization, without making ordinary tab inactivity a page-reload problem. This is a specific implementation, not a claim about every Grafana view. |
| [Chrome heap snapshot guidance](https://developer.chrome.com/docs/devtools/memory-problems/heap-snapshots) | Compare retained objects and detached DOM; inspect retaining paths | Validate repeated navigation after GC and avoid confusing first-load allocation or console retention with application leaks. |
| [VS Code terminal documentation](https://code.visualstudio.com/docs/terminal/basics) | Explicit scrollback limit, configurable rather than unlimited | Keep a clear output retention budget; do not copy its exact default without Dockge2 workload measurements. |
| [HTTP cache guidance](https://web.dev/articles/http-cache) | Distinguishes immutable versioned resources from content requiring revalidation | Preserve current hashed-asset delivery; avoid applying the same policy to authenticated live API responses. |

## Implementation sequence

Each row is a separately reviewable work package. Sizes are relative scope estimates, not delivery promises. No package authorizes a release or deployment.

| Order | Work package | Size / dependency | Evidence required before completion |
| --- | --- | --- | --- |
| 0 | Repeatable production performance fixture and counters | S; first | Fixed stack/history sizes, browser version, cold/warm conditions, subprocess counts and sanitized output; reproduce F01/F04 |
| 1 | Lifecycle repair: modals and stale async terminal callbacks | S-M; 0 | Heap retaining-path comparison, 100 navigation cycles, focus/transition/late-ack tests; no unrelated cache changes |
| 2 | Bounded Git previews and expiring metadata ownership | M; 0 | Concurrent near-limit previews, idle expiry, cancellation, eviction and safe apply; measure transient and retained bytes |
| 3 | Visibility-aware request coordination | M; 0 | Hidden/resume/reconnect/command cases; zero hidden ordinary polls; preserve true unknown/error states |
| 4 | Demand-driven logs and progress renderers | M; 1, 3 | Process/subscription counts, reconnect replay and running-command tests; renderer and session lifecycles separated |
| 5 | Stable list identities and snapshot-owned derived rendering | M; 0, 1 | F04 call-count/trace comparison; unchanged-row render count; locale/window/status correctness; heap does not grow with snapshots |
| 6 | Reuse one host read per round; batch availability and bound source reads | M-L; 0 | Docker/query counts at 1 and 5 viewers; current post-operation state; permission projections; slow/failing Docker |
| 7 | History and streaming hot paths | M-L; 0, 6 | Realistic long history, query plans, availability parity, burst output and bounded replay; optimize only demonstrated bottlenecks |
| 8 | Route delivery, dependency/style pruning and optional virtualization | M; 4, 5 | Bundle graph plus cold/warm route traces; no loading waterfall or keyboard/navigation regression |
| 9 | Constrained-host qualification and release guidance | M; accepted packages | Defined 1 vCPU / 1 GiB trial, prolonged soak, published-image install/update, measured headroom and documented limitations |

Packages 1-5 are the first delivery wave. Server collection follows with its own correctness tests. If profiling does not show a material history/bundle bottleneck, defer that optimization rather than adding an expensive architecture prematurely.

For every application package: run `npm run check`, a production frontend build and the targeted behavioral/integration checks. Compare the same production scenario before and after; record regressions as well as gains. Keep changes separable so a failed scheduling/cache optimization can be reverted without reverting source-preservation or lifecycle fixes.

## Validation matrix and initial targets

Targets below are proposed acceptance criteria, not achieved results or advertised hardware guarantees.

| Dimension | Cases | Measurements / target |
| --- | --- | --- |
| Navigation and retained memory | 20-cycle screening, then 100 overview/inspector/files cycles after warmup | No linear retained-instance/listener growth; investigate any growth beyond a repeatable heap noise envelope |
| Rendering | 10/50/200 stacks; 10/100/500 container rows using fixtures, with selected real isolated Docker cases | User Timing, long tasks, component updates, frame/interaction traces; target p95 representative click-to-next-paint under 200 ms on the agreed constrained browser profile |
| Visibility and transport | Hidden for 10 min; resume; lost socket; slow agent; operation completes while hidden | No idle client polling while hidden; one logical refresh on resume; no demand for manual page reload; bounded pending requests |
| Server scaling | 1/5 tabs, local and 3 remote agents, cold/warm metadata | Docker subprocesses, DB queries, Node/children RSS and CPU separately; collection work independent of local viewer count |
| Git/files | Large YAML up to the supported file limit, near-20 MiB trees, concurrent previews, external edits | Byte budget includes construction; expiry releases references; file hashes and rollback remain correct |
| History | 24 h/7 d/30 d, stable and flapping states, observation gaps, retention edges | Query plan/time, rows loaded, allocation, exact availability/coverage parity |
| Output | Sustained logs, burst logs, reconnect, terminal interaction | Bounded replay bytes and renderer queue; responsive input; explicit truncation; no missing completion state |
| Assets | Cold load, warm load, first inspector/files visit, version update | Existing entry limits preserved; include route JS/CSS/fonts in reporting; no stale HTML/chunk mismatch |
| Security and lifecycle | Logout, role change, endpoint removal, late acknowledgement | No stale private projection, leaked subscription or re-registered disposed object |
| Deployment | Published-image install/update on a dedicated 1 vCPU / 1 GiB VM; 30 min screening then 24 h soak | No OOM or unexplained RSS slope; record panel, daemon and workload memory separately; longer runs required before advertising support |

The browser can run on a different machine from the panel server. Test a constrained browser profile separately from a small server VM. CPU throttling approximates slower execution, not low available RAM. Docker workloads require their own memory budget and cannot be included in a universal panel-only minimum. A 512 MiB deployment claim is outside the current evidence.

Do not claim production INP from a short scripted test. Report the measured interaction distribution and scenario; collect real INP only through an explicitly chosen telemetry approach.

## Out of scope for the first wave

- A framework rewrite, wholesale Composition API/Pinia migration, SSR or a new permanent monitoring subsystem.
- A service worker caching authenticated API responses or persisting compose/env contents.
- Global `markRaw`, `v-once` or memoization of mutable data without replacement/invalidation contracts.
- Broad `KeepAlive` around editor routes as a workaround for lifecycle defects.
- Cross-user pooling of authenticated agent connections or cached permission decisions.
- Workers, delta protocols, permanent history rollups or file-backed preview storage before measurements justify their complexity.
- Raising bundle/coverage limits, suppressing true stale/error states, or reducing source-preservation and write-revalidation guarantees to improve benchmark numbers.

## Audit completion and limitations

The production build completed successfully. Isolated browser scenarios reproduced files-route retention, repeated date formatting and eager terminal rendering. Source checks established the remaining architectural findings. This task adds the report and sanitized baseline only; no application fix, commit, release or deployment is included. The full application test suite was not rerun for this documentation-only task.

The next implementation should begin with a repeatable fixture and the lifecycle defect, then rerun the retention experiment before attributing the remaining memory growth or selecting additional caches.
