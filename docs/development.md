# Development

This page is for working on the source. To run the panel, see [installation](installation.md).
What kind of change is accepted is in [contributing](../.github/CONTRIBUTING.md), and the project
guide for people and agents is [AGENTS.md](../AGENTS.md).

## In a container

The host needs only Docker:

```bash
cp .env.example .env   # once
./local.sh             # ./local.sh -d keeps it in the background
```

The script recreates the Compose project `dockge2-local` from `docker-compose.local.yml` and runs
`npm run dev` inside it: Vite on http://localhost:5000 and the backend on http://localhost:5001,
both reloading on change. Dependencies live in their own volume and are reinstalled when the
lockfile or the Node version changes.

The stacks directory defaults to `/tmp/dockge2-stacks` and the database to `./data`, so development
never touches a real `/opt/stacks`. `DOCKGE_LOCAL_STACKS_DIR` and `DOCKGE_LOCAL_DATA_DIR` in `.env`
change them. On macOS and Windows set `CHOKIDAR_USEPOLLING=true` for file changes to reach the
watcher.

Stop it with:

```bash
docker compose -p dockge2-local -f docker-compose.local.yml down
```

## On the host

Node.js 22.23.2 or 24.19.0 (`.nvmrc` pins 24.19.0), Git, and Docker for anything that runs
containers.

```bash
npm install
npm run dev              # backend and frontend together
npm run dev:backend      # Express and Socket.IO on 0.0.0.0:5001
npm run dev:frontend     # Vite on 0.0.0.0:5000, for development only
npm run build:frontend   # production bundle into frontend-dist/
```

Point the panel at separate directories with `DOCKGE_DATA_DIR` and `DOCKGE_STACKS_DIR`; never run it
or the tests against your own database or stacks. For a review instance with real containers and
edge-case stacks, `extra/seed-review.ts` prepares both under `.tmp/review`, and its header shows how
to start the panel on them.

The production image builds the frontend itself (`docker/Dockerfile`, stage `build_frontend`), so a
deployment never needs Node. Building the bundle locally is useful to look at it without a Docker
build.

## Checks

```bash
npm run check                     # lint, strict TypeScript, vue-tsc, unit tests with coverage
npm run test:unit                 # unit tests only
npm run test:docker-integration   # needs a working Docker Compose
npm run test:install              # updater, release and bootstrap contracts, no containers
npm run test:updater              # Go tests of the host updater
```

`npm run check` is what a change has to pass before it is submitted. `npm run test` enforces the c8
coverage floor of 70%. Build the frontend first: one of the tests starts a whole panel with
`NODE_ENV=production`, and in that mode the backend refuses to start without
`frontend-dist/index.html`. The Docker integration tests are skipped unless
`DOCKGE_DOCKER_INTEGRATION=1` is set; CI runs them in a separate Linux job.

`npm run test` then runs `npm run coverage:floors`, line floors per subsystem on top of the global
70%: access and sessions 80, stack files 80, container state 85, agent transport 70. The groups are
listed by hand in `extra/check-coverage.ts`, and an empty group fails. `npm run check:bundle` limits
the first load of a built frontend to 780 KiB raw and 250 KiB gzip. c8 and
`node --test --experimental-test-coverage` measure the same code differently (81.09% against 90.01%
of lines once), so a threshold does not carry over from one to the other.

An unhandled rejection or an uncaught exception ends the server (`backend/fatal-error.ts`): it cleans
up and exits with code 1, and the container's `restart: unless-stopped` brings it back. Do not catch
such errors to keep a half-broken process alive.

### Browser tests

```bash
npx playwright install chromium   # once
npm run test:e2e                  # real Chromium, real clipboard, real Docker
```

The end-to-end tests start their own backend and frontend, seed a temporary data directory and run
a container from `test/e2e/seed.ts`. They use the real clipboard, the real xterm and a real
container on purpose: a stub would hide exactly the bugs they are there to catch.

### Visual tests

```bash
npm run test:visual               # compare the interface with the approved baseline
npm run test:visual:approve       # re-approve it, only when the change of look is intended
```

The visual run needs no Docker and no backend: it renders the production components against the
fixed scene in `test/visual/scene.ts`, so the same revision always gives the same frame. Baselines
are committed under `test/visual/baseline/`. A difference fails the run and is reviewed one by one;
re-approving is a decision, not a step of the run.

## Performance checks

Build once, then run the isolated production probe:

```bash
npm run build:frontend -- --manifest
npm run test:performance
```

The probe creates its own database, account and undeployed stack directories, runs 100 files-route
round trips, and removes its temporary runtime when it finishes. It reads the host Docker state but
never deploys the fixture stacks. Results and private runtime logs stay under the ignored
`output/performance/`; publish only the sanitised result JSON.

For deterministic row counts without contacting the host Docker daemon:

```bash
DOCKGE_PERF_CONTAINERS=500 DOCKGE_PERF_STACKS=50 DOCKGE_PERF_CYCLES=5 DOCKGE_PERF_CPU_RATE=4 npm run test:performance
```

| Variable | Effect |
| --- | --- |
| `DOCKGE_PERF_OUTPUT` | Output directory |
| `DOCKGE_PERF_VIEWERS=5` | Compare one and five dashboard clients against the synthetic Docker fixture |
| `DOCKGE_PERF_VISIBILITY=1` | Inject visibility events and record outgoing event names, not their arguments |
| `DOCKGE_PERF_LIMITS=1` | A 30 minute screen under `MemoryMax=1G` and `CPUQuota=100%` in a systemd user scope, backend children included, Chromium and the Docker daemon excluded |

This tests application scheduling, not the operating system's tab suspension, and it is not a
substitute for qualification on a small VPS, which is open in the backlog of
[the master plan](plans/2026-08-26-dockge2-master-plan.md).

### Caches

Every cache needs an owner, an identity key, a byte and entry budget, eviction, a freshness rule and
invalidation tests; a timeout that does not release the object is not expiry. Current container
state is never cached as truth: share one in-flight read, timestamp the sample, keep errors as
errors. The budgets in use: Git previews 128 MiB of accounted payload, 10 entries, 10 minutes (not an
RSS limit); source metadata 4 MiB, 512 entries, 60 seconds; terminal replay 1 MiB, 100 chunks, with a
truncation notice. An unanswered write is an unknown outcome and is never replayed automatically.

### Tried and rejected

- An index on `stack_observation (observed_until, observed_at)` over 500,000 rows: the 7-day query
  regressed, the 30-day one kept a full scan, and the 24-hour gain came from the existing index after
  `ANALYZE`.
- A virtualization dependency for long lists. Container rows are paged by 50 instead, after a
  measured 500-row bottleneck: p95 511 ms before, 109 ms after, at CPU x4.
- Until a measurement justifies them: history caches or rollups, workers, a delta protocol, a service
  worker, pooled agent sockets, broad `KeepAlive`, blanket `markRaw`.

## Releases

Images are published only by the tagged release workflow; `npm run build:docker` and the npm
release scripts refuse to publish. How a release is signed, verified and installed is in
[verified self-updates](self-updates.md).
