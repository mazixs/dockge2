# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

`dockge2` is a fork of [Dockge](https://github.com/louislam/dockge) — a self-hosted, stack-oriented `compose.yaml` manager. Work happens on our own `main` (renamed from `master` on 2026-08-26); we do not decide for the upstream owners. Active requirements and agreed decisions live in `docs/superpowers/plans/`, with `2026-08-26-dockge2-master-plan.md` as the master journal (read it before starting feature work; it lists constraints such as coverage thresholds, security rules, and forbidden shortcuts).

Frontend and backend share one `package.json`: backend libs go in `dependencies`, frontend and tooling libs in `devDependencies` (the frontend is compiled into `frontend-dist/`, so its deps never ship).

## Commands

```bash
npm install                # Node 22.23.2 or 24.19.0 (see engines / .nvmrc)
npm run dev                # backend (5001) + frontend dev server (5000) together
npm run dev:backend        # tsx watch, binds 0.0.0.0:5001
npm run dev:frontend       # vite, binds 0.0.0.0:5000

npm run lint               # ESLint over **/*.{ts,vue}; npm run fmt to autofix
npm run check-ts           # tsc --noEmit, strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npm run test               # = coverage: c8 + node:test, enforces 70% lines/statements/functions/branches
npm run test:unit          # tests without coverage gate
npm run check              # lint + check-ts + test — run this before claiming work is done
npm run build:frontend     # production bundle into frontend-dist/
```

Run a single test file or a single test:

```bash
node --import tsx --test test/backend/util-stack.test.ts
node --import tsx --test --test-name-pattern "envsubst" test/common/util-common.test.ts
```

Tests use the Node test runner with `--test-concurrency=1` (shared SQLite/`Settings` static state). Backend tests that need a DB wrap the body in `withDatabase()` from `test/helpers/database.ts`, which creates a temp `dataDir`, runs Knex migrations, and tears everything down. Coverage counts only `backend/**` and `common/**`; `.c8rc.json` excludes the socket/agent plumbing that needs a live Docker host, so new logic belongs in testable units rather than inside handlers.

CI (`.github/workflows/ci.yml`) runs lint → check-ts → test → build on Linux/Windows/macOS × Node 22.23.2/24.19.0.

## Architecture

### Socket.IO is the API

There are almost no REST endpoints (`backend/routers/main-router.ts` only serves the SPA and entry HTML). Everything the UI does is a Socket.IO event with an ack callback returning `{ ok, msg?, msgi18n? }`. `DockgeServer` (`backend/dockge-server.ts`) wires, per connection, three kinds of handlers:

- **`socketHandlerList`** — `SocketHandler` subclasses, no agent support: auth/setup/settings (`main-socket-handler.ts`), agent CRUD (`manage-agent-socket-handler.ts`).
- **`agentSocketHandlerList`** — `AgentSocketHandler` subclasses that register on an `AgentSocket`, not the raw socket: stack lifecycle (`docker-socket-handler.ts`) and terminals (`terminal-socket-handler.ts`).
- **`agentProxySocketHandler`** — the single `"agent"` event router.

Handler conventions: call `checkLogin(socket)` first, validate every argument (`typeof(x) !== "string" → throw`), then reply via `callbackResult` / `callbackError` from `backend/util-server.ts`. `ValidationError` maps to a translatable validation response. `DockgeSocket` (same file) is the augmented socket type carrying `userID`, `endpoint`, `instanceManager`, and `emitAgent`.

### Multi-agent proxying (the part that surprises people)

One Dockge instance can manage stacks on other Dockge instances ("agents"). Every agent-aware call is emitted by the frontend as `emitAgent(endpoint, eventName, ...args)` → server event `"agent"`, and `AgentProxySocketHandler` dispatches by endpoint:

- `ALL_ENDPOINTS` (`"##ALL_DOCKGE_ENDPOINTS##"`) → fan out to every connected agent;
- empty string or own `socket.endpoint` → handle locally via `agentSocket.call(...)`;
- anything else → forward over the outbound socket.io-client connection in `AgentManager`.

`AgentManager` (`backend/agent-manager.ts`) is created **per browser socket** and holds one socket.io-client per agent (URL/username/password from the `agent` table). Agents identify themselves with an `endpoint` request header; the remote side stamps `endpoint` onto outgoing payloads via `socket.emitAgent`, which is how the frontend keys `allAgentStackList` by endpoint. Any new stack/terminal feature must therefore be registered as an agent handler and called through `emitAgent`, or it will silently work only on the local host.

### Which files of a stack are used

`common/stack-files.ts` holds the explicit allow-list of file names (`compose.yaml`, `compose.prod.yaml`, `.env`, `.env.dev`, `.secret.db`, …) and `backend/stack-config.ts` resolves them: `resolveStackFilePath()` is the single barrier that rejects `..`, absolute paths, symlinks and unknown name shapes before any read or Compose argument. The selection itself (main compose file, ordered CLI env files, edited env file, secret bindings) lives in the `setting` table under key `stackFiles` with type `stackFiles` — there is no dedicated migration, and the general settings screen cannot overwrite it. `Stack.getComposeOptions()` therefore always emits an explicit `-f` plus `--env-file` in order, and `Stack.loadFileConfig()` has to run before any Compose call (`Stack.getStack()` does it).

Secrets are plain files written with mode `0600`. Metadata (name, size, mtime, bound services) travels with the stack response; content never does. `revealSecret`, `saveSecret` and `deleteSecret` require the user's current password via `doubleCheckPassword`, while `bindSecret`/`unbindSecret` only need a login because they touch the compose file, not the value.

### Stacks are files, not database rows

`backend/stack.ts` is the core model. A stack is a directory under `stacksDir` (`DOCKGE_STACKS_DIR`, default `/opt/stacks`) containing one of `acceptedComposeFileNames` plus `.env`; the database stores only users, settings, and agents (`backend/migrations/`, accessed through Knex — `Database.getKnex()`). Status comes from shelling out to `docker`/`docker compose` via `spawn` in `backend/child-process.ts` (a promise wrapper over `node:child_process`, with `timeoutMs` and `maxBuffer`). The numeric constants live in `common/util-common.ts` (`UNKNOWN`/`CREATED_FILE`/`CREATED_STACK`/`RUNNING`/`EXITED`/`ATTENTION`) and the aggregation is in `common/compose-status.ts`: instances are normalised from `docker ps`/`docker compose ps` and judged fail-closed — `RUNNING` needs a running long-lived service and zero issues, anything degraded is `ATTENTION` with reasons, unreadable output is `UNKNOWN`. A clean `exited(0)` only counts as expected when the service is marked one-shot (`x-dockge: {lifecycle: one-shot}` in the compose file or a `dockge.lifecycle=one-shot` container label). The stack list resolves every project from a single host-wide `docker ps` call; a 10-second cron in `DockgeServer.serve()` pushes `stackList` to every logged-in socket.

Compose YAML edits must preserve the user's file: `copyYAMLComments` exists because the file on disk is the source of truth, and per the master plan a load/validate/deploy round trip must not silently re-serialize YAML.

### Terminals

`backend/terminal.ts` wraps node-pty. `Terminal` instances are kept in a static `terminalMap` keyed by name, so names are generated by the shared helpers in `common/util-common.ts` (`getComposeTerminalName`, `getCombinedTerminalName`, `getContainerExecTerminalName`) — always reuse those instead of building name strings ad hoc, since the frontend joins the same key via `bindTerminal`. Output is broadcast to socket rooms; `InteractiveTerminal`/`MainTerminal` add stdin. The main shell terminal is gated by `enableConsole` / `DOCKGE_ENABLE_CONSOLE`.

### Shared code and frontend

`common/` is the only code imported by both sides: status constants, terminal-name helpers, `envsubst`, YAML comment copying, port parsing. Put anything the UI and server must agree on here.

The frontend is Vue 3 options-API SFCs with mixins as the state layer: `frontend/src/mixins/socket.ts` owns the socket connection, login/JWT, `stackList`/`allAgentStackList`/`agentStatusList`, and `emitAgent`. Pages are in `frontend/src/pages/`, and Bootstrap-Vue-Next components are auto-imported (`frontend/components.d.ts` is generated — don't hand-edit).

## Conventions

Follow `.editorconfig` and ESLint: 4-space indent (2 for YAML), LF, double quotes, semicolons, `array-bracket-spacing: always`, JSDoc on non-obvious methods. Naming: `camelCase` in TS/JS, `snake_case` for SQLite columns, `kebab-case` for CSS/SCSS.

Settings belong in the UI (`Settings` table + settings components), not in new environment variables; env vars are reserved for startup concerns (`DOCKGE_STACKS_DIR`, `DOCKGE_PORT`, `DOCKGE_DATA_DIR`, `DOCKGE_SSL_*`, `DOCKGE_ENABLE_CONSOLE`).

Translations: add new keys to `frontend/src/lang/en.json` only. A CI job (`prevent-file-change.yml`) blocks changes to any other `frontend/src/lang/*.json`.

Never add a socket event that lets the browser run arbitrary git/shell/Docker commands, and treat compose/env/secret filenames as safe relative names inside the stack directory (reject absolute paths, `..`, and symlinks).

`AGENTS.md` covers the same ground for other agents but predates the test setup — the commands above are authoritative.
