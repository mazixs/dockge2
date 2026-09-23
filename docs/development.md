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
substitute for qualification on a small VPS. Measured results, rejected experiments and what is
left are in [the performance results](plans/2026-09-22-performance-results.md).

## Releases

Images are published only by the tagged release workflow; `npm run build:docker` and the npm
release scripts refuse to publish. How a release is signed, verified and installed is in
[verified self-updates](self-updates.md).
