# Performance implementation and validation

Date: 2026-09-22. Base: `d1003358dc5c231997d64da0fad80856b829bdfc`, application version 0.0.7.
Scope: local implementation of the [approved audit plan](2026-09-22-performance-audit-and-plan.md).
No commit, tag, image publication or deployment is included.

The initial working tree contained the audit report, its baseline JSON, and the existing
`StabilityDashboard.vue` simplification of the stale-observation message. That change is preserved.
All other application changes described here belong to this implementation. An unrelated formatter
change in `CreateStackSheet.vue` was restored; its existing blank-line lint warning remains.

## Implemented work packages

| Plan | Implementation | Main evidence |
| --- | --- | --- |
| 0 | Isolated production probe, retained heap/DOM/listener counts, synthetic Docker protocol, slow-browser mode, viewer and visibility probes | `extra/performance-*.ts`, `extra/performance-docker.cjs`; reproducible commands in CONTRIBUTING |
| 1 | Bootstrap modal ownership and transition-aware disposal; pending terminal binding generations; bounded request transport acknowledgements | 100 production navigation cycles; lifecycle and delayed-ack tests; real browser command/file/terminal scenarios |
| 2 | Global Git preview byte budget, active expiry, discard on navigation/deletion, serialized preview construction; bounded source metadata | Near-limit Git trees, eviction and safe-apply tests; cache idle-expiry tests |
| 3 | Visibility-aware overview refresh and age clocks; inspector polling pauses; coalesced reads and bounded transport deadlines | Scheduler tests advance ten hidden minutes; browser visibility injection is recorded separately |
| 4 | Logs acquire their stream on demand; progress renderer mounts when a command/output exists; stale join/leave protection | Real PTY and browser journal/progress/session tests |
| 5 | Stable stack keys, structural sharing of unchanged authoritative rows, snapshot-derived date labels and one Intl formatter per locale | 500-container overview: one date-format call in a six-second age-clock interval |
| 6 | Reuse the observed list for publication, batch availability reads in groups of 400, limit source reads to four workers, index stack paths for runtime matching | Availability parity; one/five-viewer command counts; existing authorization projections retained |
| 7 | History distributes intervals only to overlapping buckets; replay bounded by bytes and chunks with explicit truncation | History boundary/gap/duplicate tests and microbenchmark; real 4 MiB PTY burst |
| 8 | Lazy settings routes, individual Bootstrap modules; 50-container pages after a measured large-table bottleneck | Production bundle budget; 500-row CPU x4 before/after comparison; pagination identity/boundary tests |
| 9 | Local constrained-server screening fixture and deployment guidance | 1 CPU / 1 GiB systemd scope; dedicated VPS and 24 hour qualification remain outstanding |

## Measurements

Local CPU: Intel Core i7-11700K. Node 22.23.2. Chromium 151.0.7922.34. Production frontend.
Measurements are controlled local samples, not production INP, device-wide RAM or universal hardware
requirements. Raw local evidence is under ignored `output/performance/`; a sanitized selection is
kept in [performance-results.json](2026-09-22-performance-results.json).

### Retention after navigation

The original audit found retained heap increasing from 13.91 MiB to 23.05 MiB and 29.88 MiB after
successive ten-cycle files-route blocks, with approximately 6,460 extra nodes and 800 listeners per
block. The production validation after modal/terminal ownership repair used 50 undeployed fixture
stacks and read-only discovery of the local host:

| Checkpoint | Retained JS heap, MiB | CDP nodes | Listeners |
| --- | ---: | ---: | ---: |
| 20 files round trips | 14.18 | 4,564 | 239 |
| 40 | 14.64 | 4,564 | 239 |
| 60 | 15.42 | 5,168 | 317 |
| 80 | 15.05 | 4,564 | 239 |
| 100 | 15.84 | 5,168 | 317 |
| Settled | 15.29 | 4,564 | 239 |
| Inspector-only control | 14.90 | 4,644 | 225 |

No page errors occurred. Transient extra nodes/listeners disappear after settling; the former linear
retention pattern was not reproduced. Heap is measured after requested GC, not browser RSS or peak
allocation. The older exploratory baseline used a different harness; do not interpret the table as
a precise percentage improvement. The full 100-cycle run preceded the final transport-deadline and
pagination changes; those received subsequent targeted browser/probe validation.

### Large overview and slow browser

Both runs use 500 synthetic running containers in 50 managed stacks, 48 history buckets per container,
and Chromium CPU throttling at 4x. Twenty scripted filter activations measure click to the second
animation frame, including Vue rendering. This is a controlled proxy for responsiveness, not INP.

| Metric | All 500 rows rendered | 50 rows per page |
| --- | ---: | ---: |
| Scripted interaction p95 (nearest rank) | 510.8 ms | 108.9 ms |
| Maximum | 638.4 ms | 133.9 ms |
| Warm overview DOM elements | 58,107 | 6,541 |
| Settled retained heap | About 35 MiB | 16.55 MiB |
| Age-clock date formatting in 6 seconds | 1 call | 1 call |
| Age-clock long tasks in that interval | 292 ms | None recorded |

Pagination keeps native tables, links and buttons, independently per endpoint. Overall counts still
describe all containers. A large stack can span pages; deleting containers clamps an out-of-range
page. No list virtualization dependency, hidden duplicate table or persistent UI data cache is added.

### Server work, history and output

With ten synthetic containers, one visible overview and then five visible overviews each generated
three `compose ls` and three aggregate instance reads in separate 30 second steady-state windows.
The one-minute runtime inspection happened in only one window, as expected from its independent
clock. Mount-time reads are excluded. This verifies local dashboard collection behavior; selected
inspectors still have per-client service reads, and three remote agents were not benchmarked.

The browser visibility-injection probe recorded zero outgoing agent requests during 35 seconds of
hidden overview and 12 seconds of hidden inspector. Resume emitted one overview request, or one each
for service status, Docker usage and stack availability. There were no page errors. Scheduler unit
tests additionally advance ten hidden minutes; actual OS tab suspension remains a separate gap.

For 100 containers with 5,000 intervals each and 48 buckets, the old history algorithm took about
229-237 ms in warm samples; the replacement took about 14-16 ms. This is an algorithm microbenchmark,
not a whole-application speedup. Availability semantics, gaps and boundary coverage remain tested.

A real PTY wrote 4 MiB plus a completion marker. The live client received every payload byte; replay
stayed below 1 MiB plus its truncation notice. Replay also retains at most 100 chunks. Terminal
process lifetime remains separate from renderer lifetime, so an interactive session survives tab
switching and a command can finish while its output view is closed.

## Cache and freshness contracts

- Git previews: one process-wide 128 MiB accounted payload budget, at most ten entries, ten-minute
  active expiry. Accounting includes both retained file trees, conservative UTF-16 comparison text
  and an index capped at 2 MiB. Construction is serialized and tree/file limits remain enforced.
  The budget is not a process RSS limit: construction, apply, serialization and allocator overhead
  require additional headroom. Cancellation does not interrupt a write that already owns its preview.
- Source metadata: 4 MiB / 512 entries / 60 seconds, active expiry and coalesced reads. Explicit
  source mutations invalidate it; a read from an older generation cannot repopulate it afterward.
- Docker usage: existing short shared-reading behavior remains; post-operation publication invalidates
  it, stale in-flight results cannot replace a new generation, and failure is an error rather than
  cached empty success. Inspector usage is cleared on failed reads.
- UI snapshots: server responses remain authoritative, including removal of fields after a role
  change. Structural sharing only preserves equal subtrees. No saved health, secret, compose or env
  data is introduced in local storage, IndexedDB or a service worker.
- History labels: owned by the visible snapshot/page and locale; the current freshness boundary is
  evaluated separately. A hidden page resumes automatically and still shows genuine unknown/error
  states when the server cannot provide current observations.
- Request deadlines: the application and Socket.IO acknowledgement use the same timeout. An
  unanswered write becomes an unknown outcome and is never automatically replayed. See the official
  [Socket.IO timeout contract](https://socket.io/docs/v4/client-api/#sockettimeoutvalue).

## Deferred or rejected changes

A trial index on `(observed_until, observed_at)` over 500,000 observation rows did not consistently
improve queries: the seven-day case regressed and the 30-day case retained a full scan. The apparent
24-hour improvement used the existing index after ANALYZE, so it cannot justify the proposed index.
No migration was added. No history-result cache, rollup, worker, delta protocol, service worker,
authentication socket pool, broad KeepAlive or blanket markRaw conversion was introduced.

Initial JS was reduced from about 707.17 KiB raw / 226.81 KiB gzip to 675.46 KiB / 221.80 KiB including
pagination; the final bundle check is recorded in the result JSON. Existing
limits remain unchanged. Build memory has not been solved: use the published image on small hosts,
not a frontend build on a 1 GiB VPS.

## Validation boundaries

The final `npm run check` passed 571 tests, lint and both TypeScript checks. Line coverage is 88.27%,
branch coverage 85.36%; all coverage floors passed. The production build, bundle limits, 17 real
Docker/Chromium scenarios and updater dry-run passed. The preexisting blank-line lint warning in
`CreateStackSheet.vue` remains. The test-created `e2e-files` container and empty network were removed
explicitly after teardown failed to parse that fixture's intentionally changed Compose environment.
No user workload was removed. Exact final results are recorded in the accompanying JSON.
Failed exploratory harness runs are excluded: one used an older
modal implementation, one raced the first observation timeout, and one shared an overwritten build.
The fixture now copies the build to its own runtime to prevent that last failure mode.
An isolated subset of the browser suite also exposed an existing fixture-order dependency: the
progress spec needs the files spec's configured environment. The complete six-spec group was rerun;
its result is recorded separately rather than treating the failed subset as a passing run.

The 30 minute local constrained screen completed with exit code 0 and all 30 HTTP checks successful.
The scope enforced one CPU and 1 GiB. MemoryCurrent ranged from 147.27 to 186.87 MiB during the idle
screen and ended at 153.24 MiB; MemoryPeak including preceding navigation was 261.48 MiB. The last
transport and log-demand refinements were made after this screen started and were validated by the
subsequent full check and browser run, not by a second 30 minute soak. The transient scope and its
runtime directory were removed on completion.

The constrained screen covers the backend and its command children, not the Docker daemon, managed
workloads or browser. It is primarily idle after navigation, not a sustained Git-update workload.
Remaining release qualification: a dedicated 1 vCPU / 1 GiB VPS with published-image install/update,
24 hour soak, three remote agents, real OS hidden/suspended-tab behavior, sustained multi-viewer log
backpressure, transient RSS during concurrent near-limit Git operations, and browser retaining-path
snapshots. These are explicit qualification gaps; this work does not advertise a new minimum RAM.
