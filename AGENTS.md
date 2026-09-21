# AGENTS.md

Guidance for anyone - human or AI agent - working in this repository. `CLAUDE.md` points here,
so there is one description of the project rather than two that drift apart.

Dockge2 is a fork of Dockge: a self-hosted manager for `compose.yaml` stacks. Work happens on
`main`. Node 22.23.2 or 24.19.0; `.nvmrc` pins 24.19.0.

The project is led in English: code, comments, documentation, commit messages and interface
strings. The interface is translated into the most widely spoken languages, so English is the
language the rest is translated from, not a preference.

## Scope

A stack is the unit of the interface: its directory, its files, its running services. Keep the
directness of the original Dockge - pick a stack, understand its state, do the one thing you came
for.

The target scenario: point at a Git repository, choose a branch and a compose file, check the
settings, deploy. On an update the user sees what changed, understands the consequence, and
chooses which version of each file to apply and which local edit to keep.

Do not grow this into a general administration panel like Portainer. No infrastructure sections,
metrics, roles or permanent dashboards without a concrete scenario. Agents, the terminal and the
settings stay supporting features.

## Commands

```bash
npm run dev            # backend 5001 + frontend 5000 (dev:backend / dev:frontend separately)
npm run check          # lint + check-ts + check-vue + test - run this before handing work over
npm run lint           # ESLint over **/*.{ts,vue}; npm run fmt fixes what it can
npm run check-ts       # tsc --noEmit (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
npm run test           # c8 + node:test, coverage floor 70%
npm run test:unit      # the same tests without coverage
npm run test:install   # install.sh against a docker stub, no container is touched
npm run test:docker-integration   # needs a live Docker Compose
npm run test:e2e       # Playwright, a real Chromium and real containers
npm run test:visual    # reference screenshots; :approve re-approves them deliberately
npm run build:frontend # builds into frontend-dist/

node --import tsx --test test/backend/util-stack.test.ts                       # one file
node --import tsx --test --test-name-pattern "envsubst" test/common/util-common.test.ts  # one test
```

`.c8rc.json` sets the 70% floor for lines, statements, functions and branches. Do not lower a
threshold to make a check pass.

An application change needs lint, TypeScript, tests for the behaviour it touched, and a build. CI
also runs coverage, Docker, the browser suite and `npm run update-docker -- --dry-run`. For a
documentation change pick checks in proportion, and never report a check you did not run.

Isolate data through `DOCKGE_DATA_DIR`, `DOCKGE_STACKS_DIR` and the E2E parameters. Never run tests
against the user's own database or stack directory. `docker ps` on a development machine can list
someone else's stacks: do not touch them while testing.

## Where things live

| Path | What is there |
| --- | --- |
| `backend/dockge-server.ts` | assembly point: Express, Socket.IO, handler registration, the 10 second cron |
| `backend/socket-handlers/` | events without the agent proxy: settings, agent CRUD, users; `agent-proxy-socket-handler.ts` routes the `"agent"` event |
| `backend/agent-socket-handlers/` | agent-compatible events: stacks, git, terminals, stability |
| `backend/stack.ts`, `stack-config.ts`, `stack-source.ts`, `stack-git.ts` | the stack as a directory, file path resolution, sources, git |
| `backend/auth.ts`, `auth-access.ts`, `agent-auth.ts` | Better Auth, sessions, `doubleCheckPassword`, agent access |
| `backend/mcp-*.ts` | MCP server, policy, keys, delegated operations (see `docs/mcp.md`) |
| `backend/stability.ts` | container state history, uptime and availability |
| `backend/terminal.ts` | node-pty wrapper, the static `terminalMap` |
| `backend/child-process.ts` | promise wrapper over spawn for docker / docker compose |
| `backend/database.ts`, `backend/migrations/` | Knex + SQLite: users, settings and agents only |
| `backend/util-server.ts` | `DockgeSocket`, `checkLogin`, `callbackResult` / `callbackError` |
| `common/` | shared by front and back: `util-common.ts` (statuses, terminal names, envsubst), `compose-status.ts`, `compose-editor.ts`, `stack-files.ts` (the file name allow-list), `availability.ts`, `agent-socket.ts` |
| `frontend/src/mixins/socket.ts` | the state layer: connection, session, `stackList`, `emitAgent` |
| `frontend/src/pages/`, `components/`, `layouts/` | Vue 3 SFCs on the options API |
| `frontend/src/styles/tokens.scss` | design tokens (light on `:root`, dark on `body.dark`); `vars.scss` mirrors them for legacy code |
| `frontend/src/i18n.ts`, `frontend/src/lang/` | the language list and the catalogues; see `frontend/src/lang/README.md` |
| `test/backend`, `test/common`, `test/frontend` | unit tests against real files and processes; `test/helpers/database.ts` has `withDatabase()` |
| `test/docker/`, `test/e2e/`, `test/visual/` | Docker integration, Playwright, reference screenshots |
| `extra/` | scripts: `reset-account.ts`, `update-dockge.ts`, `deploy-stack.ts`, `seed-review.ts` |
| `docker/`, `.github/workflows/` | images and CI |
| `docs/` | see the documentation map below |

## Architecture in short

- **The API is Socket.IO**, not REST: every event has an ack callback `{ ok, msg?, msgi18n? }`. A
  handler does `checkLogin` first, then validates every argument, then `callbackResult` /
  `callbackError`.
- **Multi-agent**: the front end calls `emitAgent(endpoint, event, ...)`, the server routes it
  locally, to every endpoint (`ALL_ENDPOINTS`) or into an outgoing socket.io-client connection from
  `AgentManager` (one per browser socket). A new feature touching stacks or terminals has to be an
  agent handler, or it only ever works locally.
- **Stacks are files, not database rows**: a directory under `DOCKGE_STACKS_DIR` (`/opt/stacks` by
  default). Status comes from a single `docker ps` and is aggregated fail-closed in
  `common/compose-status.ts`.
- **Editing compose preserves the user's file**: `analyseComposeSource` / `canEditStructurally` /
  `applyStructuredEdit` in `common/compose-editor.ts`. Text is rewritten only on an explicit edit.
- **Secrets** are files with `0600` permissions; only metadata ever leaves the server, and
  `revealSecret` / `saveSecret` / `deleteSecret` require `doubleCheckPassword`.
- **Authentication**: Better Auth is mounted on `/api/auth/*` before the body parsers, the session
  lives in an `httpOnly` cookie, and the socket receives `userID` at the handshake. Public signup is
  off; the first owner is created from a one-use code in the data directory. The owner creates
  users, revokes access and resets passwords. Roles are checked on every Socket.IO event and every
  nested agent call. A viewer has no access to files, secrets, logs or terminals.
- **Stability**: `backend/stability.ts` records each container's state by Docker ID at most once a
  minute. Uptime comes from `StartedAt`; availability over 24 hours, 7 and 30 days is computed from
  confirmed intervals only. After 90 seconds without a fresh observation the current figures are
  unknown rather than assumed good.
- **MCP** is off by default. Keys are individual and revocable, scoped to servers and stacks;
  writes go through prepare/apply with a deadline, a re-check of the caller's rights and replay
  protection. Cross-server calls use a signed limited context, never the browser session and never a
  forwarded external key. Tool annotations and hidden buttons are not a substitute for a server-side
  check.

## Files and Git state

- Reading, showing state, starting, stopping and updating images must never modify the user's
  compose or env files as a side effect.
- Do not rebuild YAML from a plain object: keep comments, order, quoting, anchors, extensions,
  special tags and untouched text. Saving without an edit must produce the same bytes.
- Writing is allowed for an explicit user edit or a chosen comparison result. Keep panel metadata
  out of the compose file, as `backend/stack-config.ts` does, and never add service fields
  automatically.
- Keep three things apart: the files on disk, the last checked Git version, and what is actually
  deployed. Saving a file is not a deployment.
- A Git difference is not a container failure, and a local edit is not automatically a conflict:
  ask for a choice when changes cannot be merged safely.
- Show the comparison and the resulting choice before replacing files. No implicit `reset --hard`,
  `clean`, stash or overwrite of the working copy.
- Allow cancelling before the write, restore the originals when a write fails, and re-check the
  files before applying. Rolling files back does not roll container data back.
- After saving a local version, keep showing that it still differs from Git.
- Never show secrets or credentials from a Git URL in a diff, a list, a log or a mockup. Use
  invented data for demonstrations.

Git currently supports fast-forward only, regular files, and compose/env files at the root. No
submodules, no symlinks, no merging diverged branches. Limits: 1000 files, 1 MB per file, 20 MB in
total. A preview lives 10 minutes in memory. On a failed write there is a rollback; a crash may
require recovery from `.git/dockge-recovery-*`.

## Interface

- The first screen answers: what is running, what needs attention, how to open or add a stack.
- One main action per step; rare and dangerous actions are revealed on request. The compose file and
  the logs of the selected stack open directly.
- The terminal appears when a session is open or a command is running. An empty console does not
  occupy the work area.
- Name states in words; colour supports the label. Distinguish stopped, failed, unknown and
  update-available.
- The Git flow: check changes -> compare files -> choose the result -> validate compose -> apply and
  deploy -> show what actually happened. The comparison sides are "on the server" and "from Git".
- Keyboard navigation, narrow screens, local fonts and `prefers-reduced-motion` are requirements.
  Use the shared tokens and the translation catalogues, not per-component colours and strings.
- When reworking the interface, match real actions, their availability and their error states
  against the mockups. A demonstration button is not functional completeness.

## Conventions

- Four spaces (two in YAML), LF, UTF-8, final newline, double quotes, semicolons,
  `array-bracket-spacing: always`, JSDoc on public and non-obvious methods. `camelCase` in TS,
  `snake_case` for SQLite columns, `kebab-case` for CSS. `.editorconfig` and ESLint decide the rest.
- Settings live in the UI (the `setting` table). Environment variables are for startup only:
  `DOCKGE_STACKS_DIR`, `DOCKGE_PORT`, `DOCKGE_DATA_DIR`, `DOCKGE_SSL_*`, `DOCKGE_ENABLE_CONSOLE`,
  `DOCKGE_TRUSTED_ORIGINS`, `DOCKGE_TRUST_PROXY`, `DOCKGE_SECURE_COOKIES`, `DOCKGE_AUTH_SECRET`.
- Backend dependencies go in `dependencies`, front end and tooling in `devDependencies`.
- No HTML inside a translation string - markup goes through `<i18n-t>`. `en.json` is the source of
  truth and `ru.json` is kept complete.
- **Never add an event that lets the browser run arbitrary git, shell or Docker commands.** Stack
  file names are safe relative paths only: no `..`, no absolute paths, no symlinks.
- Never commit keys, passwords, local data or test sessions. Leave other people's uncommitted work
  alone. Report vulnerabilities through `SECURITY.md`, not a public issue.

## Docker and local data

- The standard containerised development run is `./local.sh` with `docker-compose.local.yml`. It
  recreates the `dockge2-local` project, so find out first whether that environment is in use.
- The dependency volume is refreshed when the lockfile or the Node version or platform changes. Use
  `DOCKGE_LOCAL_DATA_DIR` for a separate database and `DOCKGE_LOCAL_STACKS_DIR` for stacks.
  `DOCKGE_MCP_DELEGATION_CONFIG` is passed by both compose configurations; the file goes in the
  mounted data directory, see `docs/mcp.md`.
- `docker-compose.yml` is the production configuration of this repository. Always pass `-f`
  explicitly.
- Stack paths inside and outside the container have to be identical. Do not change a user's
  directories or env files to demonstrate a design.
- `docker/Dockerfile` is self-contained: it builds the frontend and the healthcheck itself and
  pulls only official `node` and `golang`. Nothing has to be built or pushed beforehand, so a bare
  server needs Docker and nothing else. Do not reintroduce a base image that lives only in a
  registry - it makes a fresh install depend on someone having pushed it.
- The image is published by `.github/workflows/release.yml` on a `v*` tag, to
  `ghcr.io/mazixs/dockge2` with the built-in token. Docker Hub is optional and skipped without
  credentials. `latest` is only moved by a tag without a dash in it.
- Memory is the reason the image is published at all: the frontend bundler peaks near 1 GB and no
  flag brings it under about 900 MB, while running the panel takes about 200 MB. Installs and
  updates download the image and build only when there is none, so a 1 GB server stays usable.
- `build:docker` and the release scripts push to a registry. They are not a routine check: read the
  command before running it.

## Documentation map

| File | What it records |
| --- | --- |
| `README.md` | install, update, rollback, reverse proxy, FAQ |
| `CONTRIBUTING.md` | what kind of change is accepted and how to submit it |
| `SECURITY.md` | how to report a vulnerability |
| `docs/authentication.md` | accounts, sessions, proxy configuration |
| `docs/mcp.md` | the MCP contract, limits and verified clients |
| `docs/design-system.md` | tokens and the current layout |
| `frontend/src/lang/README.md` | which languages, and how to translate |
| `docs/plans/2026-08-26-dockge2-master-plan.md` | the running journal of requirements and decisions - read it before a feature |
| `docs/plans/`, `docs/design/` | historical plans and audits, in Russian. They record what was decided and why; the code is the current state, not these |
