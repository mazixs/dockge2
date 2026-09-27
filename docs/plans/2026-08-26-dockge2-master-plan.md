# Dockge2 master plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** Keep in one living plan all of the owner's requirements, the agreed decisions and the
stages of dockge2's development: updating the technology stack, security, automated tests, CI/CD,
integrating useful upstream fixes and updating the Docker deployment safely.

**Architecture:** Keep Vue 3 + Vite on the frontend and Express + Socket.IO + SQLite/Knex on the
backend, replacing only components that are confirmed to be outdated or unnecessary. Keep fixes to
Stack, Compose, YAML and the container update as separate small tasks with real tests. Human
authentication runs on Better Auth (migrated on 2026-08-27), separately from registry secrets, the
Docker socket and the machine authentication of agents.

**Tech Stack:** Node.js 24.21.0 LTS as the main runtime (pinned in `.nvmrc`), Node.js 22.23.2 LTS
also supported (`engines` in `package.json`); TypeScript, strict; Vue 3; Vite; Express; Socket.IO;
Knex; better-sqlite3; Better Auth; YAML; the Node test runner; c8; Playwright; Go for the updater
(`extra/updater/`); Docker Compose; GitHub Actions.

**Spec:** This file is the main journal of requirements and decisions and the only tracker. Every
new requirement of the owner and every decision taken together is added here before the work on it
starts.

## How this file is kept

Every new requirement of the owner or decision taken together is added to this file before it is
implemented. Each entry records the date, the requirement or decision as worded, the reason, the
tasks and files it touches, and its current status. A finished item is ticked only after the checks
its task lists.

**Deleted plans.** The subordinate plans, audits and reviews that the journal entries below refer
to were deleted from the tree on 2026-09-26: their open items moved to the "(backlog, ...)" sections
and the checklist, their rules to `docs/*.md`, and the rest is history. To find a deleted file:
`git log --diff-filter=D --name-only -- docs/plans docs/design`; to read it:
`git show <commit>^:<path>`. The tree keeps only the decomposition of unfinished work; a finished
plan is folded in here and deleted.

The file is kept in English. The entries up to 2026-09-21 were written in Russian; on 2026-09-27
the file was translated and the journal condensed to its decisions. The original wording is in the
history of this file.

## Global constraints

- Supported Node.js versions: 22.23.2 and 24.21.0; where nothing is incompatible, choose 24.21.0.
  `.nvmrc` pins 24.21.0 and `engines` in `package.json` reads `22.23.2 || 24.21.0` (Node 24.21.0
  since the journal entry of 2026-09-26, "dependencies brought up to what the release age allows";
  24.19.0 before).
- TypeScript checks all TypeScript code strictly (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` in `tsconfig.json`). The JavaScript blocks left in Vue SFCs were to
  move to `lang="ts"` or be excluded only with a documented technical reason. Done on 2026-09-26
  (journal, "technical debt from the reviews and audits, closed for 0.0.14"): every component with a
  script is `lang="ts"` and passes `vue-tsc` with `strictTemplates` (`npm run check-vue`), and
  `test/frontend/sfc-type-check.test.ts` keeps a new one from coming back as JavaScript.
- Automated test coverage must be above 60%; the c8 floor is 70% for lines, statements, functions
  and branches (`.c8rc.json`). On top of it `extra/check-coverage.ts` holds line floors per
  subsystem (see "Current state"). A floor is not lowered to make a run pass.
- Automated tests must not use stubs that bypass or break the logic under test. Use the real file
  system, the real `process.execPath`, real Docker Compose integrations and pure functions for
  deterministic logic.
- ESLint uses a correct flat configuration (`eslint.config.js`) and checks TypeScript and Vue
  without a legacy configuration.
- CI/CD must check lint, TypeScript, tests with coverage, the frontend build and a high-level
  dependency audit on Node.js 22.23.2 and 24.21.0. As it runs on 2026-09-27 (`ci.yml`): tests with
  coverage and floors and the frontend build run on both versions; lint, `check-ts`, `check-vue`,
  shellcheck, the bundle budget and `test:install` run once, on 24.21.0. No workflow runs a
  dependency audit; supply is guarded by `min-release-age=7` in `.npmrc` and Dependabot cooldowns
  (journal, 2026-09-26, "technical debt from the reviews and audits, closed for 0.0.14"). No entry
  dropped the audit, so this part of the rule is open.
- `package.json` scripts must be minimal, understandable and actually used; dead and duplicate
  commands are removed.
- Do not add a new library when a built-in Node.js API or a dependency already in use solves the
  task reliably.
- Backward compatibility with old data. On 2026-08-27 the owner lifted it: no version of the fork
  had been released and there were no installations, so breaking schema changes were allowed, and
  preferred when they removed a legacy path; compatibility was kept only where it came cheap. The
  owner's reason: vulnerabilities most often move into a new version through migrations and kept
  old data. The premise no longer holds: releases 0.0.1 to 0.0.14 are published (the first on
  2026-09-19) and installations exist. Existing data is now carried forward. Schema changes are Knex
  migrations in `backend/migrations/` that run on the database of an earlier release, for example
  `2026-09-26-1200-account-issuer` (journal, 2026-09-26, "dependencies brought up to what the
  release age allows"), and the installer imports installations from 0.0.7, 0.0.8 and 0.0.10
  (`docs/updating.md`, "Upgrading an older installation"; `docs/self-updates.md`, "Legacy import").
  Panel data is not downgraded: an older panel refuses a database with a migration it does not
  know, and a rollback restores the data snapshot. No journal entry restates the rule after the
  first release; this item records the practice.
- Do not change the structure of a Stack or the format of its files on disk without a reason: the
  stack files belong to the user, unlike the internal database schema.
- Never run dangerous operations automatically: `git reset --hard`, `git clean -fdx`,
  `docker compose down -v`, `docker volume prune`.
- Do not add a remote Socket.IO method that lets the browser run arbitrary Git, shell or Docker
  commands.
- Check paste into the terminal with a real browser and the real Clipboard API; do not replace the
  clipboard, xterm, Socket.IO or Docker only to get a green test.
- The content of a Compose file from Git is the source of truth: loading, validation and deployment
  must not serialise the YAML again without an explicit edit.
- Accept Compose, env and secret file names only as safe relative names inside the stack directory;
  reject absolute paths, `..`, walking out of the directory and symlinks.
- Keep secrets out of the common Stack JSON, logs, error messages and stack list responses; reading
  their content is a separate, explicitly authorised action.
- Changes are made in this fork, dockge2; we make no decisions for the owners of the original
  Dockge repository.
- For IC use the formula `Impact × Confidence`, both on a scale of 1-5; state effort and risk
  separately.
- New UX and dashboard features count as P2/P3 and do not rank above fixes to security, statuses,
  Compose/YAML, TypeScript and coverage.
- The global inventory of containers and the right to control containers outside managed Compose
  stacks were to be independent settings or capabilities, with managed-only control as the safe
  default. Changed on 2026-09-26 (journal, "list, containers outside the stacks, the panel's own
  stack"): the inventory is not a setting - external projects and standalone containers are always
  shown, since seeing them adds no capability (no actions, no files, no environment); control stays
  separate as the owner setting `containerControl`, per server, off by default and turned on with the
  password. Delete, kill and exec on such containers wait for their own access model.
- Show an availability percentage only with its time window, the number of observations and an
  explicit count of `UNKNOWN`; missing history is not 100%.
- The fork's main branch is `main`; `master` was the outdated name, to be replaced on the remote
  after agreement. Done on 2026-09-16: the default branch on GitHub is `main`, and `main` is the only
  branch of the remote.
- The fork has its own version numbering, by SemVer; the forms `2`, `2.1` and `2.0.1.1` are not used
  as a release version. Decision of 2026-09-19: the first publication goes out as `0.0.1`, to try the
  image release on a live server rather than spend the number of the stable version on testing the
  release pipeline. The earlier decision that `2.0.0` is the first public version is cancelled;
  `2.0.0` stays reserved for the first release declared stable. A release candidate is
  `X.Y.Z-rc.N`, and a candidate that fails the release gate keeps its number unused rather than the
  pushed tag being moved (journal, 2026-09-26, "0.0.14 goes out as a release candidate first"). The
  release number does not decide agent compatibility; that is `AGENT_PROTOCOL_VERSION` in
  `common/agent-socket.ts`, because `0.0.1` of this fork is newer than `1.4.0` upstream.
- The public name must not automatically rename the technical `dockge`, `DOCKGE_*`, API events and
  the upstream image without a compatibility map and a check of the project's own registry. The
  name is now written "Dockge2" (`README.md`, `AGENTS.md`); the registry is `ghcr.io/mazixs/dockge2`,
  and the `DOCKGE_*` variables and the event names are unchanged.

## Requirements

### Quality and dependencies

- Carry out a code review of the project.
- Update the libraries of the stack.
- Replace dead libraries with maintained equivalents or built-in APIs.
- Check that the chosen libraries fit the current architecture, rather than adding dependencies for
  a formal fix.
- Move the project from a non-LTS Node.js to an LTS one: use 24 when compatible (now 24.21.0),
  otherwise 22.23.2.
- Set up strict TypeScript checking.
- Check and fix ESLint.
- Remove redundant and unused scripts from `package.json`.
- Update CI/CD to current versions of the actions and supported Node.js versions.

### Automated tests

- Add automated tests with coverage above 60%.
- Tests check real results, not only that functions were called.
- Use real temporary directories and files for path traversal and `.env`.
- Add a separate integration check with a real Docker Compose for Docker behaviour.
- Check errors and unknown states fail closed, rather than turning them into a successful status.

### Upstream Dockge

Useful pull requests are integrated into our fork even if upstream has not accepted them yet:

- PR #997 for issue #994: close reading `.env`/Compose and deleting directories through path
  traversal. Integrate it with a common safe path, a symlink check and real tests; do not copy the
  upstream test that replaces `Terminal.exec`.
- PR #979 for issue #964: keep `.env` when a Stack is added or changed, empty an existing file when
  its content is removed, and do not create a new empty `.env` without need.
- PR #950 for issue #806: count a Stack as running when its services run and its init containers
  exited cleanly. Adapt it to `backend/child-process.ts`, add a timeout and an output limit; do not
  bring in `promisify-child-process`. Replaced on 2026-08-26 (the journal entry on `ATTENTION`
  statuses): one-shot is never guessed. An unmarked `exited(0)` next to a running service gives
  `ATTENTION` with a reason; only a service marked one-shot may exit cleanly (`docs/faq.md`).
- PR #991 for issue #990: keep `tmpfs.mode: 01777` and do not change the meaning of the YAML scalars
  `yes`/`no`/`on`/`off`. Use the current `yaml` library and round-trip tests.

The detailed tasks and acceptance criteria were in `docs/plans/2026-08-26-upstream-dockge-fixes.md`,
deleted on 2026-09-26 (see "How this file is kept"). All four are done (see the checklist below).

### Container console and the choice of shell

- In the container console `Ctrl+V`, `Ctrl+Shift+V` and `Cmd+V` on macOS must work, as well as an
  explicit "Paste" action in the right-click context menu.
- Paste uses the real Clipboard API, handles a refused permission and falls back to the `paste`
  event of the hidden xterm field; do not use the unreliable `document.execCommand("paste")`.
- Paste into an interactive console sends the exact text to the PTY and loses no spaces, line
  breaks or special characters. The main restricted console keeps its semantics: pasted text does
  not run without a separate Enter.
- Remove the false behaviour of "Switch to sh": choosing a shell creates a separate session with a
  new terminal identity, closes or detaches the current client's old session and shows an error when
  the chosen executable is not in the container.
- The remote event of the interactive terminal allows only the listed shells (`sh`, `bash`); the
  service name and the stack are checked before the PTY starts. The new API does not allow an
  arbitrary shell command.
- Never write the content of the paste buffer or the selection to the logs.

### Detailed container monitoring

- Build the stack status from the rows of services and their instances in
  `docker compose ps --all --format json`, not from the one aggregated row of `docker compose ls`.
  Done on 2026-08-26: the stack list reads one `docker ps --all` filtered by the Compose project
  label, and the stack page reads `docker compose ps --all` with its Health and ExitCode fields.
- Statuses distinguish `RUNNING`, `ATTENTION`, `EXITED`, `CREATED` and `UNKNOWN`. `N/A`, a missing
  instance, a mixed state and an unavailable Docker must not show as a plain `inactive`.
- `RUNNING` means that every tracked long-lived service is running or healthy. A partly running
  stack, `unhealthy`, `restarting`, an unknown status or a missing instance give `ATTENTION`, with a
  warning icon and the list of the services in trouble.
- A one-shot worker or init container that exited successfully must not turn a stack with running
  services into `EXITED`; a non-zero exit code is visible as a problem. For ambiguous services use an
  explicit lifecycle mark rather than guessing from the container name.
- The stack page shows the status of every service and instance, including `State`, `Health`,
  `ExitCode` and the reason for a warning; the start/stop/restart buttons rely on the typed status,
  not on `serviceStatus[0]`.

### Env files and Docker Compose secrets

- Choose and store the main Compose file of a stack; do not rely on Docker Compose finding one
  itself when the directory holds several YAML files.
- Support an active env file with any safe name, such as `.env`, `.env.product` or `.env.dev`, and
  an ordered list of env files for CLI interpolation. Keep `global.env` as a separate global source.
- Keep three things explicitly apart: the CLI `--env-file` for Compose interpolation, the service
  field `env_file` that passes variables to the container, and Docker Compose `secrets`. Never turn a
  `.secret` into environment silently.
- Add secrets management as separate files, starting with `.secret`: a logical secret name maps to
  a file, the file is stored with restricted permissions, and the Compose YAML gets an explicit
  `secrets` reference only on a user action. A service's access to the secret must be visible
  through `/run/secrets/<name>` after deployment.
- Do not send the content of secret files with the ordinary `getStack`; editing and revealing a
  secret is a separate action, masked by default. Check rotation, removal and that nothing leaks
  through logs or errors.
- Saving YAML must not create `networks: {}` only because the network editor is empty. A `networks`
  key missing from the source stays missing; a key the user wrote is kept, and removing the last
  network removes the key only after an explicit action.
- Support Compose `include` and the YAML tags `!reset`/`!override` by preserving the source text, or
  by a safe read-only mode when the structural editor cannot save them without changing their
  meaning.

### Deploying Compose files from Git

- The audit found no separate Git deployment module in the checkout of the time; that was recorded
  as a gap, not as grounds to consider the problem solved. Now: stacks from Git are
  `backend/stack-git.ts` (clone, check, compare, apply; fast-forward only), with every call of git
  through `backend/git-command.ts`; see `docs/git-stacks.md`.
- The configuration source of a Git stack stores the repository and branch or commit, the main
  Compose file, the env files and the secret references explicitly. After `git pull --ff-only`
  Dockge must read the chosen file again, drop the stale cache and never write old content from
  memory over the Git version.
- Before `docker compose up` run
  `docker compose -f <chosen file> --env-file <chosen files> config --quiet`; on an error, do not
  start and do not overwrite the stack. Pass all arguments as an array, without `shell: true` and
  without secrets in URLs or logs.
- Pass the path of the chosen Compose file explicitly with `-f`; this removes the difference between
  the file the UI shows and the file Compose would pick by itself.
- Treat `networks: {}` in the canonical output of `docker compose config` as the model Compose runs,
  not as a reason to change the source YAML. Never save the canonical preview back into the Git file.
- Do not add `simple-git` or a separate Compose parser without proven need: run Git through the
  argument-based process layer that is already checked, and let the Docker Compose CLI itself check
  the Compose semantics.

Upstream discussions and issues related to this block: [#141](https://github.com/louislam/dockge/discussions/141)
and the closed PR [#623](https://github.com/louislam/dockge/pull/623) on paste,
[#370](https://github.com/louislam/dockge/discussions/370) on secrets,
[#760](https://github.com/louislam/dockge/issues/760) on choosing the Compose file,
[#294](https://github.com/louislam/dockge/discussions/294) on `include` and the empty `networks`,
[#448](https://github.com/louislam/dockge/issues/448) on YAML tags and
[#36](https://github.com/louislam/dockge/discussions/36) on Git stacks.

### Authentication and secrets

- **Done on 2026-08-27:** human authentication moved to Better Auth 1.7.2 (1.7.5 now). The former
  browser JWT, the bcrypt hashes and the `login`/`loginByToken` events are removed entirely.
- Use Better Auth only in its minimal configuration: users, passwords, server sessions,
  `httpOnly`/`secure` cookies, TOTP and backup codes, and the built-in attempt limits. Do not add
  OAuth, SSO, organisations, SCIM, passkeys or other plugins without a separate requirement.
- Do not consider authorisation solved by it: add our own capabilities/RBAC for Stack, Docker,
  agents, the registry and users. Done in part: three roles (owner, operator, viewer) are checked on
  every Socket.IO event and every nested agent call (`docs/authentication.md`). Open, per the role
  audit of 2026-09-24 (journal, "the owner turns the console on, role audit"): no per-stack or
  per-agent scope for browser users (MCP keys have it), no 2FA reset or requirement, no session list,
  no audit log outside MCP.
- Do not keep a browser JWT in `localStorage`; move to a server cookie session with expiry and
  revocation.
- Socket.IO checks the Better Auth session at the handshake and the rights before every protected
  action.
- Do not use agent passwords as machine authentication; move to separate scoped API keys with
  rotation, or mTLS. Still open: a panel reaches an agent by signing in to it with a service account
  and its password (`backend/agent-auth.ts`, `docs/authentication.md`, "Agents"); scoped keys exist
  for MCP only.
- Keep registry credentials apart from Better Auth; use a Docker credential helper or a separate
  secret manager.

Why the migration was needed, recorded from the source code before it was done: sign-in and access
recovery went through the Socket.IO events `login`/`loginByToken`
(`backend/socket-handlers/main-socket-handler.ts`), the JWT was kept in the browser's
`localStorage`/`sessionStorage` (`frontend/src/mixins/socket.ts`), and the server check of protected
actions came down to the `socket.userID` flag (`backend/util-server.ts`). The JWT had no set expiry
(`backend/models/user.ts`), and the code had no server `logout` handler.

Better Auth is not excessive for exactly this boundary: it officially supports Express, SQLite,
server sessions, CSRF and trusted origins, rate limiting and TOTP. Excessive would be enabling all
of its plugins or handing it the rights over Docker. It is integrated through its own tables
(`user`, `session`, `account`, `twoFactor`) in the same SQLite file, with migrations run by
`getMigrations(auth.options)` at startup. The former users table and the JWT were removed without a
way back, because compatibility had been lifted before any release (see "Global constraints").

### Docker registry and docker login

- `docker login` authenticates the Docker CLI to a registry; it is not a way to sign in to Dockge.
- `--password-stdin` is required instead of passing the secret as a process argument, but on its
  own it does not stop Docker from storing the credentials.
- A registry is checked as `hostname[:port]`; do not accept arbitrary URLs, HTTP or `--insecure`
  without an explicit policy of the environment.
- A registry token must not reach Settings, the UI, logs or `--password`.
- Use minimal read-only tokens and a credential helper.

The panel runs no `docker login` of its own (checked 2026-09-27). The image update check uses the
host's credential helpers, asks the registry API with an anonymous token or the plain `docker login`
entry, and sends credentials only to an HTTPS realm (journal, 2026-09-24, "env on edit, image update
check without buildx").

### Git and Docker updates

Replaced: the panel is no longer updated by `git pull` and `docker compose up`. A release
installation is updated by the signed updater `<installation>/.dockge2/update`, from the host or from
Settings -> About (journal, 2026-09-25, "updating the panel from the web interface";
`docs/updating.md`, `docs/self-updates.md`). The scenario first recorded here, on 2026-08-26, was
this basic safe sequence:

~~~bash
git pull --ff-only origin main
docker compose up -d --pull always --wait --wait-timeout 60
~~~

and, when a forced recreation was needed:

~~~bash
docker compose up -d --pull always --force-recreate --wait --wait-timeout 60
~~~

- Recreating a container does not delete bind mounts or named volumes.
- In `docker-compose.yml` the data directory (`/app/data` inside) and the stacks directory (the same
  path inside and outside) are mounted from the host, so the data physically outlive the container.
- `./data` must never be deleted by Git commands; in production keep it outside the checkout, for
  example in `/var/lib/dockge/data`. A release installation is not a Git checkout: `install.sh`
  places the release files, `.env` and the updater state in the installation directory
  (`/opt/dockge2` by default), and the data directory is `<dir>/data` unless `--data-dir` names
  another (`docs/installation.md`).
- The Compose file uses a published image, so `git pull` by itself does not update the code inside
  the image; the fork's code is built and published by CI first, and the server is updated after
  that. Now: `release.yml` builds and publishes the image on a `v*` tag, installations pull it by the
  digest in the signed release descriptor, and a failed download never falls back to a build.
- Implement a local `npm run update-docker` with `--dry-run`, a check for a clean working copy and
  argument-based runs of the allowed commands; do not run it from the UI. Replaced:
  `npm run update-docker` is `extra/update-dockge.sh`, an optional entry point that hands over to
  `install.sh --update` and the same updater; an update started from the web interface was allowed on
  2026-09-25, for the verified updater only.

### A scalable interface and the dashboard

- The owner added a separate direction, not critical yet: update the interface and prioritise the
  work by IC (`Impact × Confidence`), because the current navigation suits a small number of stacks
  but scales badly with many containers.
- For StackList plan the grouping agent -> stack -> service -> instance, paged or compact output,
  search by endpoint, stack, service, image and labels, filters by status, and safe mass actions only
  for allowed Compose services. Status: item 1 of "Interface and Docker overview: open tasks".
- Show the relations between services: `depends_on`, networks, ports, volumes and secrets. First a
  read-only view of the relations; editing goes through the explicit Compose editor, and opening the
  panel does not change the YAML.
- When no agent is selected and the main area is open, show one global overview: the number of
  online, stopped and attention agents; running, attention, exited and unknown stacks and containers;
  the time of the last update; and the list of problem endpoints.
- Add availability and stability metrics: the percentage over an explicit 24 hour window with a
  switch to 7 and 30 days, the number of observations, `UNKNOWN`, last seen and the reasons for
  degradation. With too little history show "not enough data", not 100%.
- Compute historical availability from server observations kept for 30 days; do not count a one-shot
  worker that exited cleanly in the denominator of long-lived services, and never count `ATTENTION`
  or `UNKNOWN` as healthy.
- Build on the current Bootstrap/SCSS tokens and the existing `DockerStat`; add a virtualisation
  library only after measuring a list of 500 and 2000 rows. Measured: no virtualisation, the list is
  paged by 50 rows per server group (journal, 2026-09-26, "list, containers outside the stacks, the
  panel's own stack").

### Overview and control of the server's containers

- Check that containers can be discovered in any directory through `docker ps --all --format json`
  and the Docker Compose labels, not only under `DOCKGE_STACKS_DIR`.
- Keep three modes apart: the current `managed-only` for controlling Compose stacks; `all-readonly`
  for an overview of all containers; `all-control` for controlling external or standalone containers
  after a separate permission.
- Recommended safe default: keep `managed-only` control and never turn global control on
  automatically. The global read-only inventory is a separate setting; do not change the scope of
  what existing installations see silently.
- Show containers without an accessible Compose file, with an inaccessible `config_files` or from
  another unmounted directory as external or standalone, and do not promise them Compose operations.
- The key of a row is `endpoint + containerId`, not the container name; do not merge identical
  names on different agents.
- Check the actions `start/stop/restart/exec/delete/kill` on external containers against the
  capability, the endpoint and a confirmation; `exec` must not take an arbitrary command through a
  new UI without a separate model of shell access.

Decided on 2026-09-26 (journal, "list, containers outside the stacks, the panel's own stack"): the
source of a container comes from its labels only (managed, external-compose, standalone, unknown).
External projects are always shown, without an `all-readonly` switch, and the switch is not
planned. `all-control` is the owner setting `containerControl`, per server, off by default and
turned on with the password; it lets operators start, stop and restart external-compose and
standalone containers. Delete, kill and exec wait for their own access model (item 2 of "Interface
and Docker overview: open tasks").

### The panel's own container and the main console

- Check the panel's own container against the real `docker-compose.yml` and Dockerfile: image, tag
  and digest, healthcheck, restart policy, the user of the process, the Docker socket, the bind mounts
  of `/app/data` and the stacks directory, the Docker CLI and Compose CLI, and that the data survive a
  recreation.
- Show the control plane as a separate card with health, uptime, image, restart count, last seen
  and mount status. Do not let the general container button delete the panel itself or run
  `down -v`. Done on 2026-09-26: a read-only card in Settings -> About, and the server refuses down,
  delete, start, restart, deploy and update on the panel's own stack (`stackIsPanel`).
- Keep the main Dockge console off by default and state plainly that through the Docker socket the
  user gets practically host-level control. The decision "do not add turning it on from the UI" was
  reversed on 2026-09-24: an owner turns the console on in the security settings with the password,
  and `DOCKGE_ENABLE_CONSOLE` is no longer read (see the journal). Only owners open it unless an
  owner lets operators in (`consoleOperators`).
- For a restart of the panel itself, warn that the UI goes away for a moment and run only a safe
  operation; update the image through a separate Git/Compose CLI, not through an arbitrary browser
  shell. Replaced: restarting the panel's own stack is refused and stopping it stays, with a warning
  (2026-09-26); the image is updated by the signed updater, from the host or from Settings -> About
  (2026-09-25).

### Docker run to Compose

- The dependency `composerize@1.7.6` was used in `backend/socket-handlers/main-socket-handler.ts`;
  first run a corpus audit rather than replace it formally. Replaced by a converter of our own on
  2026-09-26 after the corpus, see the journal ("docker run converter of our own").
- Check the conversion of ports, mounts, env and env-file, restart, network, healthcheck, user,
  capabilities, devices, labels, `--init`, entrypoint and command; unsupported options must give a
  warning, not disappear silently.
- Fix the data-losing operation `split("\\n").slice(1)`: remove only the known top-level `name`,
  and only if the generator really added it. Done on 2026-08-27 (`stripGeneratedProjectName`); the
  code went with `composerize` on 2026-09-26.
- After conversion, parse the YAML and run `docker compose config --quiet` in an isolated directory
  without starting containers. Show the generated text in a preview with the warnings and save it
  only after an explicit action.
- Do not add `networks: {}`, `version`, privileged options or other settings "for looks" when the
  original command did not have them; a change of meaning must be visible to the user.

### Brand and version

- The owner's request at the time: the public name and the repository are `Dockge 2`, and new
  released versions must not go back to major 1. The code then named the package `dockge`, version
  `1.5.0`, and the release scripts used `louislam/dockge:1`; this was to change through a separate
  compatibility map, not a global string replacement. Done on 2026-09-16: the package is `dockge2`,
  the repository and the image are `mazixs/dockge2` (the image at `ghcr.io/mazixs/dockge2`).
- Preliminary decision of the plan: the visible name is `Dockge 2`; the technical `dockge`,
  `DOCKGE_*`, API events and upstream references stay until the migration and the project's own
  Docker registry are checked. Now: the name is written "Dockge2", and in the interface
  `BrandMark.vue` draws it on every screen (journal entry of 2026-09-15 on the third pass over the
  live instance). The `DOCKGE_*` variables and the event names stay; upstream references were
  removed on 2026-09-16 except the fork's attribution, the MIT notice, a real third-party image in a
  template and the origin of `extra/healthcheck.go`.
- The first stable version is `2.0.0`; then `2.0.1`, `2.1.0`, `3.0.0`; a release candidate is
  `2.0.0-rc.1`, a build `2.0.0+build.1`. The forms `2`, `2.1` and `2.0.1.1` are not used. Replaced on
  2026-09-19 (see "Global constraints"): numbering starts at `0.0.1`, `2.0.0` stays reserved for the
  first release declared stable, and candidates are `X.Y.Z-rc.N`.
- Synchronise `package.json`, the lockfile, the frontend version constant, Git tags, Docker tags,
  `compose.yaml`, README, favicon and icon, and GitHub Actions; do not publish the new fork under the
  upstream tag `:1`. Done (see "Brand and version" in the checklist); the root `compose.yaml` was
  removed on 2026-09-16, and the production configuration is `docker-compose.yml`.
- Update the icon and the visual style as a separate P3 task once the name is settled; check the
  favicon and PWA, the light and dark themes, contrast, alt text and accessible labels, and that no
  asset is stretched. The icon was replaced by the fork's own on 2026-09-19 (`frontend/public/icon.svg`,
  with the PNG sizes and `favicon.ico` rendered from it; git history).

The open tasks of this direction, with acceptance criteria, are in "Interface and Docker overview:
open tasks" below.

### Stack backups: recipe, volumes, snapshots (backlog, 2026-09-15)

The owner asked on 2026-09-15 whether containers could be backed up and tied to snapshots, so that
a stack could be rolled back. The same message said that the task is large, needs disk space and
control, and therefore goes to the backlog rather than into the current work.

**The problem, refined.** A "copy of a container" is the wrong object: a container is disposable,
and `docker commit` and `docker export` give a snapshot of a layer without the volumes, not
reproducible and of unclear origin. These commands are not used. The value splits into three parts,
and those are what must be copied:

- **the recipe** - `compose.yaml`, the active env files, the secrets; they lie as files in the stack
  directory and take almost no space;
- **the data** - named volumes and bind mounts; all of the size and all of the real value are here;
- **the version** - the digest of the image, not the tag: without it a rollback would bring up
  something other than what was captured.

**Control is the main design decision.** Backups must be a property of the stack, not a global
setting: the management node and a couple of containers running Telegram bots do not need copies,
and they must not be made to pay for them in disk space. Three levels per stack: no copies (the
default for a new stack), the recipe only, the recipe and the volumes (turned on explicitly, with a
size estimate before the user agrees).

**The state of Dockge itself is a low priority.** It is the control plane: if it is down, the
stacks keep running, and any other instance can bring them up from the same files. For its own
database a `VACUUM INTO` snapshot without stopping the server is enough; it needs no backlog task of
its own.

**Open questions; do not start the implementation without answers:**

1. Consistency of the volume of a running service. The options: stop the stack for the snapshot
   (correct, but downtime), a snapshot on the fly (fast, with a risk of torn data), or a dump by the
   service's own means before the snapshot. The hardest part of the task.
2. Restoring. A copy without a tested restore is pointless; restoring must be an action in the
   interface, not an instruction.
3. Space and rotation: a budget per stack, the number of snapshots kept, the behaviour when the disk
   fills. Filling the disk with copies is a way to bring down every stack at once.
4. Security: the copy contains the secrets, so it gets the same `0600` permissions and, preferably,
   encryption. Hooks around a snapshot are the most dangerous place of the task: the constraint "no
   events that let the browser run arbitrary git, shell or Docker commands" applies here too.
5. The form of the snapshot manifest: what exactly is written next to the data so that a rollback
   is reproducible (image digests, file names, the version of the manifest schema).

**Footholds in the current code:** the stack files with the allow-list of names
(`common/stack-files.ts`); the Git workflow `clone` / `preview` / `apply` (`backend/stack-git.ts`),
which works inbound today, as a source, and would have to be rethought as a receiver of recipe
snapshots; the reading of local and remote image digests (`common/image-digest.ts`). The stack model
has no volumes at all - no inventory, no sizes, no distinction between a named volume and a bind
mount; this is a new capability, not an extension of an existing one.

**Status:** backlog. No decision taken, no decomposition; do not start the implementation.

### Interface languages: translation and RTL (backlog, 2026-09-16)

The owner asked on 2026-09-16 to lead the project mainly in English and to keep a set of languages
from the most widely spoken in the world. The set is approved and already cut down in the code; the
rest is work on content, and it goes to the backlog.

**Done and closed.** `languageList` was cut down to eleven languages: English, Russian, Simplified
Chinese, Spanish, Arabic, French, Portuguese, Indonesian, Urdu, German, Japanese. 22 catalogues that
are not on the list were deleted, along with two phantoms (`mag`, `mai`) whose selection threw an
exception. `test/frontend/i18n-catalogue.test.ts` keeps the list and the files from drifting apart
again. Later only the fully translated English and Russian were left in the menu; the catalogues of
the other nine stay in `frontend/src/lang/` until they are translated (the comment on `languageList`
in `frontend/src/i18n.ts`).

**Order and choice before sign-in (2026-09-24).** The switcher lists English first, Russian second,
and the rest by name in English collation: sorting by the browser's locale put "Русский" above
"English" in a Russian browser. The language is also chosen on the sign-in screen, next to the theme
(`LanguagePicker`), so that a reset choice does not leave the sign-in form in a foreign language.
English is the default: the browser language is no longer taken into account, and a first run,
cleared storage or a stored code that the menu does not offer open the interface in English.
Russian and the rest are an explicit choice only.

**Task 1: completing the translations. The volume is measurable.** Measured on 2026-09-16:
`en.json` had 750 keys, Russian was complete, and the other nine were upstream Dockge leftovers at
14-17%, that is about 120 translated strings and 630 English ones passing for the locale, about 5700
strings of translation for all nine. Measured again on 2026-09-27: `en.json` has 1208 strings, Russian
is complete, and the other nine hold 87-105 strings each (7-9%), about 10,000 strings for all nine.
Within the set the order logically follows the number of speakers: Chinese, Spanish, Arabic, French,
Portuguese, Indonesian, Urdu, German, Japanese.

**Task 2: Hindi (`hi`) and Bengali (`bn`).** There are no catalogues for them at all. Stub files
were deliberately not added: a menu item that gives a screen entirely in English is a promise the
product does not keep. Add them together with a real translation, not before. The gap is recorded
in `frontend/src/lang/README.md`.

**Task 3: RTL. Separate work, and it is not about Arabic.** The `dir` attribute switches correctly,
but `rtlLangs` is empty while `ar` and `ur` are not in the menu; they go back there together with a
translation. The layout is not ready for it: on 2026-09-16 there were 70 physical CSS declarations
(`margin-left`, `padding-right`, `left:`, `right:`), no `[dir="rtl"]` rules and two logical
properties; counted again on 2026-09-27, 69 physical declarations, one `[dir="rtl"]` rule (in
`StackList.vue`) and no logical properties. Arabic and Urdu would give right-to-left text inside a
left-to-right layout. Urdu is in the required set, so the question is not whether to take Arabic but
whether to do RTL. The work: move the declarations to logical properties (`margin-inline-start` and
so on), add an RTL run to the visual acceptance and re-approve the references in one batch.

**Open question; do not start task 1 without an answer.** Who translates. Machine translation of
interface strings without a native speaker gives what there is now: a screen that looks translated.
The options: accept translations through pull requests from native speakers (slow, free, quality
can be checked), order them (fast, costs money, needs a glossary of Compose terms), or keep English
as the only complete language and say so honestly in the interface.

**A small item that can be taken at any time:** `en.json` had 13 keys that no component asks for
(`addFirstStackMsg`, `notAvailableShort`, `addNetwork`, `Remember me`, `newUpdate`, `rmCode`,
`rmRfCode`, `envVarCode`, `pasteAnywhereHint`, `tallyRunning`, `tallyAttention`, `tallyStopped`,
`listUpdatedAgo`); delete them together with the translation, so that nothing dead is translated.
Closed on 2026-09-26, when 13 unused keys were removed (journal, "technical debt from the reviews and
audits, closed for 0.0.14"). Of the keys listed here only `newUpdate` is left, and it is in use.

**Status:** backlog. The set of languages is approved; the content has not been started.

### Documentation in English (backlog, 2026-09-16)

The owner's decision of 2026-09-16: the project is led mainly in English, but partial Russian is
acceptable and is not a clean-up task of its own.

Translated and closed on 2026-09-16: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`,
`CLAUDE.md`, `docs/authentication.md`, `docs/mcp.md`, `frontend/src/lang/README.md`. CI and `.github`
contain no Cyrillic.

What was left then, with its measured volume:

- `docs/design-system.md` - 155 lines, 81 KB of dense prose with exact pixels and token names; to be
  translated as a separate careful task, since a specification with a garbled value is worse than a
  correct Russian one. Translated on 2026-09-27.
- `docs/plans/` - this journal and the decomposition of current work, not product documentation.
  The finished plans and `docs/design/` were deleted on 2026-09-26. A translation of the journal was
  not planned then; this plan was translated on 2026-09-27 all the same.
- About 2000 lines of Russian comments and test names, mostly in `frontend/src` and `test/e2e`.
  Mechanical work; do it along the way when a file is edited, not as a separate pass. Counted on
  2026-09-27: about 2250 lines outside the catalogues contain Cyrillic, about 1770 of them comments;
  the rest are test names, fixture texts, messages of development scripts such as
  `extra/seed-review.ts`, and test patterns that match the Russian interface on purpose.
  `docker-compose.yml` keeps its Russian comments: its SHA-256 is one of the vendor files the updater
  recognises in `extra/updater/main.go`, so even an edited comment changes what the updater accepts.
- `test/visual/scene.ts` draws the references with `locale = "ru"`. Switching it to English would
  take re-approving all 40 references (28 desktop, 12 phone) in one batch. Not decided.

**Status:** backlog, low priority. The documentation, including `docs/design-system.md` and this
plan, was translated on 2026-09-27; only comments in code remain in Russian. The owner said partial
Russian is acceptable.

### Interface and Docker overview: open tasks (backlog, moved 2026-09-26)

Moved from the deleted product-dashboard plan (Tasks 3, 5, 6, 7, 9); the state was checked against
the code on 2026-09-26.

1. **A scalable list and the relations of services.** Done in 0.0.14, see the journal, 2026-09-26,
   "list, containers outside the stacks, the panel's own stack". One thing is open: mass
   start/stop/restart - only by agreement, for chosen managed stacks, with a preview and a result
   per stack; not done without agreement.
2. **Containers outside `stacksDir`.** Done in 0.0.14, same entry. Open: delete/kill/exec for
   external and standalone containers - only after a separate access model.
3. **The panel's own container.** Done in 0.0.14, same entry.
4. **Corpus audit of `docker run` -> Compose.** Done in 0.0.14: a corpus of 51 fixtures, and
   `composerize` replaced by a converter of our own, see the journal, 2026-09-26, "docker run
   converter of our own".
5. **The final UX, accessibility and performance check.** Done in 0.0.14, see the journal,
   2026-09-26, "the final UX, accessibility and performance check", together with the English server
   refusals found on the way.
6. **Renaming an agent.** Done in 0.0.14: a button in the agent's row on Settings -> Agents.

### Operational acceptance (backlog, 2026-09-26)

Moved from the deleted reports on the self-update and on performance of 2026-09-22. Do not announce
minimum memory requirements until this passes.

- **A small host.** A dedicated VPS with 1 vCPU and 1 GiB: installing and updating the published
  image, 30 minutes of screening, then a 24 hour soak, three remote agents, a real suspension of a
  hidden tab by the OS, backpressure of the logs with several viewers, the peak RSS with parallel Git
  previews at the limit, retaining-path snapshots in the browser. Locally only the 30 minute screen
  under `MemoryMax=1G` has passed (147-187 MiB idle, a peak of 261 MiB). The soak length is fixed in
  `extra/performance-audit.ts` (30 minutes); 24 hours need a parameter.
- **Updating on a real host.** A power cut or SIGKILL and a full disk during the cutover; a host
  reboot after a successful and after a failed update - whether the identity of the installation and
  the recovery status survive. The injections in `extra/updater/engine_test.go` check the decisions
  of the journal, not the durability of the file system, Docker and SQLite. The release gate runs
  arm64 only under QEMU.
- **Production deployment.** Bind mounts, SQLite backups, the Docker credential helper, TLS, a
  reverse proxy, an image rollback - on a dedicated host, not on the test bench.
- **The host's Compose in the gate (2026-09-27).** The GitHub runner `ubuntu-24.04` (image
  20260920.314.1) carries Docker Compose 2.38.2, while the panel image, the review VPS and the
  development machine have 5.5.1. So the release gate checks only the mixed case: a host on 2.38 and
  the helper of the web update on 5.5. It was on 2.38 that CI and the gate caught `memswap_limit` and
  `create_host_path`. A host on 5.5, as after an install from Docker's repository, never passes
  through the gate; only local runs and the VPS see it. The lower bound `minCompose` 2.20.0 is not
  checked at all. Proposal: a second pass of `docker.sh`, `managed.sh` and `unmanaged.sh` with the
  5.5.1 plugin pinned by sha256 in `$DOCKER_CONFIG/cli-plugins`, keeping 2.38 as the old host. The
  cost is a longer gate. Not done until the owner decides.

### Visual audit of 2026-09-27 (backlog)

A static audit of the reference screenshots (1280 and 390 px, both themes), the markup of the
stack, create, Git comparison and panel update screens, the motion styles, the visual tests and the
state matrix, against the [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md).
No live browser run took place, so the speed, smoothness and interruption of transitions are not
assessed; the screenshots show one still frame of invented data. The audit file itself was not kept:
its findings are below.

Preliminary score 14 of 20, with no blocker on the screens checked. Accessibility 2 of 4 (visible
focus and worded states, but a long command is not announced before its result, and a Git apply
error stays above the reader's position); motion performance 3 (short `transform` and `opacity`
transitions, one global `transition: all`); adaptivity 2 (the files tab grows to 2944 px on a phone,
the overview table hides columns without a hint, the empty phone overview hides stack creation);
themes and contrast 4; consistency 3. The risk lies in feedback after long operations, phone states
and unverified transitions, not in the palette.

Screenshots cover only part of the states. Seen in references: the overview (running, failed,
stopped; both themes and widths), a stack's overview, files and log (both widths) and terminal
(1280), the first step of creating from Git (both widths), the Git choice for three files (1280),
the panel update ready, running and rolled back (1280) and running (390), the sign-in form (1280).
Read from markup and tests only, not accepted visually: loading, empty, stale data, unavailable
Docker, no history, hundreds of stacks and long names on the overview; a stack's load error,
viewer role, active and failed command, save conflict; the second create step, pasting Compose,
waiting, refusal and success; the Git result check, apply, refusal, unknown outcome and success;
a refused dry run, the password prompt, cancel, an unknown result and recovery required on the
panel update; the 2FA code, a wrong password, a setup error and mismatched passwords.

Findings, in the order the audit proposes:

1. **A Git failure can stay out of view** (P2; `StackGitChanges.vue`, `NewStack.vue`). After
   choosing versions for several files, checking the result and applying, a refusal or an unknown
   answer appears at the top of a long page while the owner is at the buttons at its bottom; the
   buttons are disabled by `Boolean(failure)`, with no scroll or focus move to the message. The same
   holds for a refused create from Git, whose message appears above the second step's form.
   `role="alert"` helps a screen reader, not a sighted owner. Done when: the refusal is visible next
   to the current action, or focus and scroll move to it; refusal and unknown outcome read
   differently; a repeat apply is not offered after an unknown outcome. Check at 390 px and with the
   keyboard.
2. **A long command is not announced before its result** (P2; `StackProgress.vue`). The name and
   count of the current step change visually, but the only `role="status"` sits on a hidden line
   filled only on `outcome`, so a screen reader hears nothing for minutes, and an empty status does
   not tell waiting from a frozen page. Done when: one calm live region announces the start, each
   significant step and the result, without every frame or second, and says what the visible text
   says.
3. **Setup errors are not tied to the fields** (P2; `Setup.vue`). Mismatched passwords or a refused
   one-use setup code go to a toast only; the fields get no error and focus stays on submit.
   Done when: the text stands next to the field, is linked with `aria-describedby`, and focus moves
   to the first field in error; the server's answer to a wrong setup code is checked separately.
4. **The empty phone overview offers no way to create a stack** (P2; `Dashboard.vue`,
   `StackList.vue`, `StabilityDashboard.vue`). On a first visit without stacks the list is closed,
   and its create button and empty state are inside it; the main area says there is nothing to watch
   yet. On a desktop the same button is visible in the side column. Done when: the empty overview
   shows one create action to a user who may manage stacks, and an explanation without a disabled
   button to a viewer.
5. **Hidden columns of the phone overview table are not marked** (P2; `StabilityDashboard.vue`,
   `phone-light/dashboard.png`). At 390 px the table has a minimum width of 670 px and scrolls
   sideways; name, state and part of the uptime show, restarts and the availability history do not,
   and nothing says the area scrolls. The history is what the overview is opened for. Done when: the
   sideways scroll is marked, or a compact phone view shows availability and restarts without hidden
   columns. Check at 390 px, with touch and with the keyboard.
6. **Secondary settings crowd out the files on a phone** (P2; `Compose.vue`,
   `StackFilesEditor.vue`, `phone-light/stack-files.png`). The files tab is 2944 px tall in an
   844 px window: after Compose and `.env` come the full file selection form, the secrets and the
   source details, all of equal weight, with the secret actions about two screens down. Done when:
   Compose and `.env` stay at hand, and the secondary groups open on request or through a short
   navigation inside the tab; at 390 px the way to choose a file and to a secret needs no search
   through a long page; saving a file stays clearly apart from deploying.
7. **The empty state grows its action by 20% on hover** (P3; `main.scss` `.action:hover`,
   `EmptyState.vue`). The wrapper scales to `1.2` with `transition: all`, while other actions only
   change colour and background; the button can cover neighbouring text, and `transition: all` also
   catches future properties. Done when: the wrapper does not scale, the button itself gives the
   feedback, and the animated properties are listed.
8. **The visual acceptance does not cover motion and part of the phone states** (P2;
   `test/visual/design.spec.ts`, `test/visual/state-matrix.spec.ts`). Every reference is taken with
   `animations: "disabled"`; phone references skip the Git comparison and the ready and rolled-back
   update; the state matrix is about the overview and the list. The `.update-expires` mask is a test
   artefact, not a defect, but it hides that line. Done when: separate browser checks run with
   motion on and with reduced motion (a tab switched in the middle of a transition, an error and a
   repeat, long texts), the Git comparison and the update result are checked at 390 px, and the
   references stay deterministic.

Closed on 2026-09-27: **the update overlay's step marker pulsed too often for a long wait**
(`PanelUpdateOverlay.vue`). It flipped its background every 240 ms (`--motion-slow`, `alternate`)
for the whole update, repainting each time. The segmented bar chosen that day replaced it: the
current segment sweeps a `transform`-only highlight once per 1.3 s and stands still under
`prefers-reduced-motion: reduce`. A recording of a long live step is still to be made.

Already sound: states are worded, with colour as a second signal; both themes use one token set,
a separate colour for Git changes, a shared focus ring and the system colour scheme; tab transitions
are short and move `opacity` and `transform`, and reduced motion is handled globally; create,
overview and files have phone references, and the stack screen keeps its state and actions on the
first screen.

Order of work: items 1-3; then 4-6; then 7; then item 8 and a repeat of the audit in a live
browser.

### Technical debt from reviews and audits (closed 2026-09-26)

Every item of the review of 2026-09-20 and the audit of 2026-09-19 is closed in 0.0.14: what was
done, and the decisions not to do something with their reasons, are in the journal, 2026-09-26,
"technical debt from the reviews and audits, closed for 0.0.14". The list of items before closing is
in the history of this file.

## Current state

As of 2026-09-27:

- **Version.** `package.json` is at 0.0.14. Published releases: 0.0.1 to 0.0.14 (the tags 0.0.9 and
  0.0.11 have no release) and the prereleases 0.0.14-rc.3 and rc.4; rc.1 and rc.2 stopped at the
  release gate. 0.0.14 passed its release gate on 2026-09-27 and is `latest`.
- **Branch.** Work happens on `main`, the only branch locally and on GitHub.
- **Checks, by level.** `npm run check`: ESLint, `tsc --noEmit`, `vue-tsc` with `strictTemplates`,
  unit tests under c8 with the coverage floors. `npm run test:install`: the Go updater and
  healthcheck tests and the release, bootstrap and privacy contracts; no container is touched.
  `npm run test:docker-integration`: a real Docker Compose. `npm run test:e2e`: Playwright with a real
  Chromium and real containers. `npm run test:visual`: reference screenshots in the pinned Playwright
  image. Also `npm run check:bundle`, `npm run lint:sh`, and `npm run test:performance`, which is run
  by hand.
- **CI.** `ci.yml` runs on a push or pull request to `main`, unless only Markdown, HTML or `docs/`
  changed. Job "Node.js" on 24.21.0 and 22.23.2: on both, tests with coverage and floors and the
  frontend build; on 24.21.0 only, lint, `check-ts`, `check-vue`, shellcheck, the bundle budget and
  `test:install`. Further jobs: Docker Compose integration, browser end to end, and reference
  screenshots inside the image the references are approved in. `json-yaml-validate.yml` checks the
  syntax of JSON and YAML files. Dependabot updates actions and npm weekly, npm with cooldowns.
- **Coverage floors.** `.c8rc.json`: 70% for lines, statements, functions and branches.
  `extra/check-coverage.ts`: line floors per subsystem - access and sessions 80, stack files 80,
  container state 85, agent transport 70, interface state 90; a group without a measured file fails.
  `extra/check-bundle.ts`: the first load within 780 KiB (250 KiB gzipped), each lazy chunk within
  480 KiB (160 KiB gzipped).
- **Release path.** `release.yml` runs on a `v*` tag that matches the version in `package.json`. It
  runs `npm run check`, `test:install`, the build and the bundle budget, Docker integration and e2e;
  builds the amd64 and arm64 image once; writes the release descriptor `release.json` and signs it
  and the updater binaries with Cosign under the identity of the workflow; runs the install, the
  managed upgrade from the previous release and the unmanaged import on both architectures (arm64
  under QEMU); signs the image, tags it with the version and creates the GitHub release (a prerelease
  when the version has a `-`), with notes from `docs/releases/<version>.md`; verifies the public
  assets, and only then `extra/release/promotion.mjs` moves `latest` - never to a prerelease and never
  backwards. Installations pull the image by the digest of the signed descriptor
  (`docs/self-updates.md`).
- **Open work** lives in the backlog sections of "Requirements" and in the unticked items of the
  checklist below; the journal keeps the history.

## Implementation plan

Finished subordinate plans are folded into the lines below and were deleted from the tree on
2026-09-26 (how to read one is in "How this file is kept"). "Item N" refers to "Interface and Docker
overview: open tasks".

- [x] Upstream fixes #997, #979, #950 and #991 with the full set of checks; a safe CLI from Git to
  Docker Compose with a dry run (later replaced by `update-dockge.sh` and the Go updater).
- [x] Console, statuses, Compose files and Git deployment: paste into the terminal, a separate
  `sh`/`bash` shell session, the `ATTENTION` status with the worker and init rules, the main Compose
  file, env files, `.secret` and Compose secrets, preserving the source YAML with an explicit `-f` and
  `config --quiet`, browser and Docker tests in CI.
- [x] The UX baseline, the blocking Vue I18n error, the choice of the "Familiar Dockge" direction.
- [x] The contract of the global overview, the dashboard without a selected agent, the availability
  and stability history for windows up to 30 days (kept 31 days, `backend/observations.ts`).
- [x] Brand and version: an image namespace and addresses of our own, numbering from `0.0.1` (now
  `0.0.14`), publication only through `release.yml`, checked by `test/install/release.test.mjs`; the
  update check looks at the releases of this repository and is off by default.
- [x] A scalable list and the relations of services: search by image and server, `?q=` in the
  address, paged output, read-only relations. Mass actions are not agreed and stay in item 1.
- [x] Containers outside `stacksDir`: classification by labels, standalone containers in the list, a
  container page, control by the owner's setting. Item 2.
- [x] The panel's own container: identified by its ID, down, delete and recreate refused, a card in
  "About". Item 3.
- [x] Renaming an agent in the interface. Item 6.
- [x] Corpus audit of `docker run` -> Compose: a corpus of 51 fixtures checked with
  `docker compose config`, `composerize` replaced by a converter of our own. Item 4.
- [x] The final UX, accessibility and performance check: 2000 containers and 300 stacks under CPU x4,
  the state matrix in `test/visual/state-matrix.spec.ts`, Lighthouse accessibility 100 on six
  screens, server refusals moved to catalogue keys.
- [x] Better Auth: a separate audit and the migration after Stack/Compose/YAML were stable.
- [x] Strict TypeScript in Vue SFCs: every component with a script is `lang="ts"`, `vue-tsc` with
  `strictTemplates` is in `npm run check`, and `test/frontend/sfc-type-check.test.ts` catches a
  return to JavaScript.
- [x] Migration of vue-i18n from the Legacy API mode to the Composition API mode.
- [x] Readiness for the production test: a green e2e, the brand and addresses without upstream, a
  fixed tag, a clean image, the static cache, the README section on deployment; CI green, a fresh
  clone passes `npm run check`.
- [ ] A fresh installation interrupted between writing `.env` and the first start cannot be
  repeated without removing `.env` and `.dockge2` by hand; see the journal, 2026-09-27, "the
  installer output in sections". Acceptance: repeating the same install command finishes it or
  says exactly what to remove, and a regression test injects the interruption.
- [ ] Backlog: operational acceptance - a small host, updating through failures on a real host,
  production deployment, Compose 5.5 on the host in the gate. Stated in "Operational acceptance".
- [ ] Backlog: findings of the visual, motion and state audit of 2026-09-27. Stated in "Visual audit
  of 2026-09-27".
- [x] The technical debt from the reviews and audits of 2026-09-19 and 2026-09-20 is closed in
  0.0.14, see the journal, 2026-09-26.
- [ ] Backlog: interface languages - completing the nine catalogues (7-9% on 2026-09-27), adding
  Hindi and Bengali, and RTL for Arabic and Urdu separately. Stated in "Interface languages"; do not
  start before the question of who translates is answered.
- [ ] Backlog: the rest of the move to English - only comments in code remain; the documentation,
  `docs/design-system.md` and this plan included, was translated on 2026-09-27. Low priority; partial
  Russian is accepted.
- [ ] Backlog: stack backups - copying the recipe, the volumes and the image digests, with levels per
  stack. Stated, with the open questions, in "Stack backups"; do not start the implementation before
  the question of volume consistency is answered.

## Decision journal

### 2026-08-26: upstream pull requests and one plan

- The owner clarified that upstream pull requests need not be rejected: we do not own the main
  repository and can integrate useful changes into our own branch. #997 and #979 are integrated;
  #950 and #991 are adapted to the current architecture and tests.
- Every further requirement and joint decision is kept in this file. The upstream fixes got a
  separate plan (deleted on 2026-09-26 with the other finished plans).

### 2026-08-26: updating the Docker deployment

- `git pull --ff-only` followed by `docker compose up --pull always --wait --wait-timeout 60` is a
  separate, safe CLI scenario; `--force-recreate` is optional.
- The automatic scenario never runs `down -v`, `volume prune`, `git reset --hard` or
  `git clean -fdx`.
- Git and Docker updates are not started from the browser's Socket.IO API. Replaced on 2026-09-25
  for the panel's own update: an owner updates the panel from the web interface through the verified
  updater.
- Bind mounts keep the data, but production data is better kept outside the Git checkout.

### 2026-08-26: Better Auth

- The move to Better Auth is a separate migration, not mixed with dependency and `Stack` changes.
- Better Auth covers authentication, sessions, 2FA and the basic CSRF, cookie and rate-limit
  mechanisms. Authorisation, agent authentication and registry secrets are designed separately.
- Minimal configuration: no OAuth, SSO, organisations, SCIM or passkeys until a requirement asks for
  them.

### 2026-08-26: console, statuses, env and secrets, Compose from Git

- The owner made `Ctrl+V`, `Ctrl+Shift+V` and paste from the right-click menu mandatory in the
  container console: without them, debugging with AI needs a separate terminal. Decision: an
  explicit "Paste" menu item, the `paste` event and an xterm key handler, tested in a real browser.
- `Switch to sh` only changed a route parameter and reused the existing PTY. Decision: a separate
  shell session, the old one detached, and an allow-list of `sh` / `bash`.
- The owner asked not to call a stack `inactive` or "dead" when only some services are missing or
  show `N/A`. Decision: aggregation by service and a separate `ATTENTION` naming the problem
  instances.
- The owner asked for `.secret`, for named env files (`.env.product`, `.env.dev`) and for choosing
  the main YAML. Decision: a typed file configuration, safe names inside the stack directory, and
  the CLI `--env-file`, the service `env_file` and Compose secrets kept apart.
- The owner reported that deploying from Git breaks YAML and adds `networks: {}`. Decision: the
  editor stops rewriting YAML, `-f` becomes explicit, and a safe Git adapter comes later. The
  canonical output of Compose is never saved back.

### 2026-08-26: a scalable interface, the dashboard, global Docker and the brand

- The owner added a P2/P3 direction: an interface that stays convenient with many agents, stacks and
  containers, prioritised by IC. IC is `Impact × Confidence`, each 1-5; effort and security risk are
  stated separately.
- With no agent selected, the main area shows a global dashboard: agents, stacks and containers by
  state, the last update, problem endpoints, and availability with its window and sample count.
- Availability comes from a server history of observations kept 30 days, not from the current list.
  `UNKNOWN` is not success, and no history gives "not enough data".
- Large lists get grouping `agent -> stack -> service -> instance`, search, filters, compact paged
  output and a read-only view of `depends_on`, networks, ports, volumes and secrets.
- `composerize@1.7.6` is not replaced without a corpus check; parameters must survive, unsupported
  flags are warned about, and the Compose CLI validates the result. Replaced on 2026-09-26: after
  the corpus, `composerize` gave way to a converter of our own.
- An audit of the panel's own container is added: health, uptime, image, mounts, the Docker socket,
  restart and update, and no dangerous self-delete. The main console stays off by default: turning
  it on means practically host-level control.
- Containers outside the stacks directory may be shown, but inventory and control are separate
  settings. The default is managed-only control; all-readonly is turned on separately, all-control
  needs a capability and a confirmation.
- The owner asked for the public name Dockge 2 and numbering from major 2. Decision: the display
  name is `Dockge 2`, the first stable version `2.0.0`; the technical `dockge`, `DOCKGE_*` and the
  upstream image stay until there is a compatibility map and our own registry. Changed on 2026-09-19
  (see "Global Constraints"): the first publication came out as `0.0.1`, and `2.0.0` is kept for the
  first release declared stable.

### 2026-08-26: the plan checked before implementation

- The code confirmed that tasks 1-4 of the upstream plan were not done and that its references
  matched the checkout, so it was accepted without rework. Work happens in the main directory of
  this repository, not in a separate `dockge2-review` copy.
- The `Stack` constructor and `isManagedByDockge` must not fail on the names of external Compose
  projects: an internal `safePath` returns undefined instead of throwing. The strict barrier stays
  for every file and Docker operation.
- Octal restoration also covers items of YAML sequences, because in issue #990 `tmpfs.mode` sits
  inside the `volumes` list. Its YAML 1.1 side effect quoted `yes` / `no`; replaced on 2026-08-27 by
  restoring the source text at node positions.

### 2026-08-26: ATTENTION statuses and a blocking vue-i18n bug

- Stack status no longer comes from the aggregated line of `docker compose ls`: the list uses one
  `docker ps --all --filter label=com.docker.compose.project`, the stack page
  `docker compose ps --all` with Health and ExitCode.
- A one-shot life cycle needs an explicit marking. An unmarked `exited(0)` next to a running service
  gives `ATTENTION` with a reason, not `RUNNING`. This replaces the earlier wording from upstream
  #806 ("running + exited(0) = RUNNING"), because the owner asked not to guess which services are
  one-shot.
- The home page did not render: vue-i18n 11 removed `$tc`. It became `$t(key, n)`, checked against
  the real library.

### 2026-08-26: stack files, env sets and secrets

- The choice of stack files (main Compose file, ordered env files, active env, secret bindings) is
  stored in the `setting` table under the key and type `stackFiles`, so no schema migration was
  needed. The general settings screen cannot overwrite it.
- One Compose file needs no choice. With several, the fallback is deterministic
  (`compose.yaml` -> `docker-compose.yaml` -> `docker-compose.yml` -> `compose.yml`, then sorted),
  and the UI asks for a choice.
- Every Compose command gets an explicit `-f` and `--env-file` in the configured order; missing env
  files are left out so the command does not fail. `global.env` stays the first source.
- `getStack` returns only a secret's name, size, date and bindings;
  `revealSecret` / `saveSecret` / `deleteSecret` require the current password. Secret files are
  written with `0600`; on Windows a warning says the permissions come from the directory.
- The label of a one-off secret does not turn into `environment`. A binding appears only through an
  explicit action, which adds the top-level `secrets` and `services.<name>.secrets` to the chosen
  file.
- Reading the file choice does not fail without the database, because the files on disk are the
  source of truth.

### 2026-08-26: `main` as the main branch

- The owner decided that the fork's main branch is `main`, not `master`.
- `npm run update-docker` pulls `origin/main` by default; `--branch=<name>` accepts only a safe ref
  name, so it cannot carry Git options, a path or shell syntax. Replaced later by `update-dockge.sh`
  and the Go updater (see "Current state").
- The remote part (pushing `main`, changing the default branch on GitHub, deleting `origin/master`)
  needs explicit permission. At the time of writing `origin/master` still held the old state.

### 2026-08-27: the source YAML kept intact

- The damaged YAML and `networks: {}` came from the `jsonConfig` watcher rebuilding the file from
  the JS model on service updates and from `NetworkInput` always initialising `networks`. Both are
  fixed.
- Write rule: the source text changes only on an explicit edit by the user, in the text editor or
  through a structural action. Loading a stack, refreshing its status and opening its page never
  touch the file.
- The structural editor is offered only when it can rebuild the file without losing meaning. With
  `include`, anchors, aliases, merge keys or custom tags only text mode remains, with an
  explanation.
- A structural edit is a targeted diff against the source document, so untouched parts keep their
  comments, quotes, style and octal notation.
- Every `up` is preceded by `docker compose config --quiet` with the chosen files; an error means no
  start. The canonical output of `config` is never saved.
- A single stack is updated from Git by the local CLI `npm run deploy-stack`, which requires a clean
  directory and runs no dangerous commands. There is still no browser API for Git. Later the
  interface got a Git flow of fixed events - check, compare, apply (see `docs/git-stacks.md`); no
  event runs arbitrary git.

### 2026-08-27: the container console and Playwright

- Paste failed because the interactive terminal listened only to `onKey`. With `onData`, native
  paste is the main path; the Clipboard API serves the menu item.
- Playwright is a development dependency: nothing else checks paste with a real Clipboard API, a
  real xterm and a real container, and the plan forbids faking those boundaries. A separate CI job
  installs only Chromium.
- The E2E environment starts its own backend and frontend and seeds a temporary data directory and a
  container. It ran with `disableAuth`; replaced the same day with the move to Better Auth, when the
  seed began creating an owner who signs in.
- The shell is part of the terminal's identity. The interactive terminal event accepts only
  `sh` / `bash` and checks the service and the shell first. `terminalLeave` closes a session left
  without clients.

### 2026-08-27: an independent review and fixes

- The day's commits were reviewed by a different model (Sonnet 5), under the rule that the review
  comes from a model other than the one that wrote the code, and the full report was requested
  without filtering.
- Blocker: editing an existing stack wrote to the historical `compose.yaml` / `.env` instead of the
  chosen files, and deploy used the wrong `-f`. `save()` now always loads the saved choice first.
- Killing `docker exec` leaves the shell running inside the container. `Terminal.end()` cancels the
  line and sends `exit`, then kills a session that ignores it.
- Secret values are redacted from `docker compose config` errors (`Stack.redactSecrets`): nothing
  guarantees that Compose will not quote one.
- Docker integration tests live in `test/docker/`, out of the unit run.

### 2026-08-27: a review by four Opus agents and fixes

Four independent agents reviewed security, the status logic and YAML editor, the terminals, and test
reliability. What was confirmed and fixed:

- **Security.** The path barrier covers a symlinked stack directory and the synchronous reads, and
  writes go through `O_NOFOLLOW`, so a file cannot be swapped between check and write. Service
  start, stop and restart go through `getComposeOptions` and `assertServiceExists`, which rejects
  values starting with a hyphen: a browser value in the service name position used to pass Compose
  flags (`--remove-orphans`, `--build`) and widen the action to the whole stack. The general
  settings screen accepts only allow-listed keys (`pickGeneralSettings`), and `setStackFiles` limits
  its array sizes. Every remaining Docker call has a timeout and an output limit, and agent proxy
  errors reach the client.
- **Terminals.** A client can leave, write to or resize only a terminal it belongs to. A container
  session ends when the server finds it without clients, so a closed tab no longer leaves it
  running. A reconnect during the grace period gets a new session, not the dying one. `end()` also
  sends EOF. Known limit: an interactive application inside the container can outlive the session,
  because Dockge does not kill processes inside the container, so as not to hit other sessions. A
  multi-line paste into the restricted console is cut to its first line with a warning, because one
  Enter ran every pasted line.
- **Statuses and YAML.** A `created` service next to a running one gives `ATTENTION`; a stack where
  nothing ever started stays `CREATED`. A stack of only one-shot tasks does not show `EXITED` while
  a task runs. `missingInstance` is reported only for a stack that is up. Update also recreates
  containers of stacks in `ATTENTION`. An unavailable Docker gives `UNKNOWN` instead of the last
  green statuses. Octal restoration puts the source text back at node positions without YAML 1.1. A
  structural write is refused when the model does not match the current text, and only removing a
  network that existed at load counts as removal.
- **Tests.** Tests that could not fail were fixed and the missing cases added. The Docker suite
  fails in CI when its environment variable is not set.
- **Coverage.** `backend/terminal.ts` and the Docker socket handler are no longer excluded from
  coverage. Line coverage fell from 85% to 78.8% against the 70% floor; the difference is gaps that
  had not been measured.

Left open as separate tasks, all five closed the same day (next entry): comments inside lists lost
on an array edit; the first structural edit normalising indentation and line endings; numeric map
keys duplicated on an edit; statuses diverging with `COMPOSE_PROJECT_NAME` in an env file;
`ATTENTION` mixing degradation with complete failure, so a stack that is down had no start button.

### 2026-08-27: the review debts closed

- The structural editor diffs a sequence item by item, so comments on untouched items survive.
  Numeric map keys are edited in place. The indentation is taken from the source and CRLF is
  restored, so the first structural edit no longer reformats the file.
- The start button appears whenever no container is running, even under `ATTENTION`. The stack list
  is sorted alert-first. The dashboard counts `unknown`, so an unavailable Docker no longer looks
  like four zeros.
- A stack's containers are matched by the label `com.docker.compose.project.working_dir`, not only
  by project name, so `COMPOSE_PROJECT_NAME` in an env file no longer gives "active" in the list and
  "unknown" on the stack page.

### 2026-08-27: the vue-i18n migration and small frontend debt

- vue-i18n runs in Composition API mode (`legacy: false`, `globalInjection: true`): the Legacy API
  is deprecated in 11 and removed in 12, and its warning was printed on every page load.
- Components do not read i18n internals; the language list comes from `availableLanguages()` in
  `frontend/src/i18n.ts`. `<i18n-t>` uses `scope="global"`.
- `currentLocale()` works without `localStorage` / `navigator`, so a unit test checks the real i18n
  configuration. A browser test covers changing the language and keeping it after a reload.
- The browser console on the home page, the stack page and `/console` is free of Vue and intlify
  warnings.

### 2026-08-27: backward compatibility dropped before 2.0.0

- The owner lifted the requirement to stay compatible with old data and the old schema: there have
  been no releases and there are no installations.
- For authentication this means the old `user` table, bcrypt hashes, the browser JWT and the
  `login` / `loginByToken` events are removed outright instead of migrated. Less code is less attack
  surface.
- Stack files (compose, env, secrets) are outside this rule: they belong to the user, and their
  format stays file-based.

### 2026-08-27: authentication on Better Auth

- People sign in through Better Auth 1.7.2: a server session in an `httpOnly`, `SameSite=Lax`
  cookie, valid for 7 days and renewed daily, `Secure` only under HTTPS. JWT, `localStorage` and
  bcrypt are gone, with their dependencies.
- Exactly one account can exist: a second registration is rejected, so a panel exposed to the
  internet does not let a stranger register. `npm run reset-account` deletes the account and its
  sessions and leaves stacks, settings and agents alone. Superseded later: public signup stays off,
  but the owner creates other users with roles, revokes access and resets passwords (see
  `docs/authentication.md`).
- The Socket.IO handshake checks the session cookie; there is no authentication event on the socket.
  A dangerous action is confirmed through `auth.api.verifyPassword` with the cookie of the same
  socket, so another session cannot confirm it.
- The `twoFactor` plugin provides TOTP and backup codes. Confirming the code rotates the session, so
  the dialog reconnects the socket.
- In development, CORS for `/api/auth/*` and Socket.IO answers only `trustedOrigins`; a preflight
  from another origin gets 403.
- E2E runs with authentication on: the seed creates an owner and `global-setup` signs in once, so
  browser tests follow the same path as a real installation.
- Markup left the translation strings: `<strong>` in `disableauth.message1/2`, printed as text by
  `<i18n-t>`, became slots.

### 2026-08-27: authentication reviewed by three agents, and fixes

Three independent Opus reviewers (backend security, frontend flow, test honesty) made more than 60
remarks. The main ones, by weight:

- Sign-in failed on any address but `localhost` with 403 `INVALID_ORIGIN`, shown as a wrong
  password. An origin is now accepted when it matches the host the browser itself requested, is
  listed in `DOCKGE_TRUSTED_ORIGINS`, or comes as `X-Forwarded-Host` with `DOCKGE_TRUST_PROXY` on.
- A forged `X-Forwarded-For` bypassed the attempt limit, and without a proxy the limit locked out
  the owner. Our middleware overwrites `x-dockge-client-ip` with the connection address, and the
  limiter reads only that.
- Whether to show the setup screen is read from the database on every connection
  (`shouldShowSetup()`). A backup code is told apart from a TOTP code (`isTotpCode`) and checked by
  its own endpoint.
- A revoked session drops its socket within the 10 second loop (`dropRevokedSessions()`).
- Password confirmation over the socket allows 5 attempts a minute per account, because
  `verifyPassword` through `auth.api` has no limit. The lockout is short on purpose, so a stolen
  session cannot lock the owner out for long.
- In `disableAuth` mode the password is checked against the owner's hash directly
  (`verifyAccountPassword`); secrets could never be used there before.
- A resubmitted 2FA form sends only the code. Changing the password and turning 2FA off reconnect
  the socket. The SPA no longer reloads on every reconnect.
- The sign-in limit is 10 a minute per client, so that browser tests and a person with a typo do not
  hit 429.
- The database file gets `0600`, and `sslKeyPassphrase` stays out of the debug log.

Known limits, accepted deliberately: up to 10 seconds between revoking a session and dropping its
socket; a TOTP code can be reused within its 30 second window (better-auth behaviour); session
tokens are stored in SQLite in the clear, so a copy of the database file is a compromise, and the UI
cannot rotate the secret; installing an older Dockge is not supported, since compatibility is
dropped before 2.0.0.

### 2026-08-27: the design system fixed

- The owner chose the "list and inspector" frame and the order of work: the paste screen first, then
  the rest. This followed four directions, four layouts of the "Control desk" direction and two
  independent reviews: a heuristic design review scored 22/40, and browser measurements found four
  contrast failures, 38 targets smaller than 24 px and no mobile layout.
- The system is `docs/design-system.md` plus `frontend/src/styles/tokens.scss` (both themes) and
  `fonts.scss` (local IBM Plex with Cyrillic). `vars.scss` carries the same values, so old `.dark &`
  rules do not diverge from new components.
- Checkable beats described: `test/frontend/design-tokens.test.ts` computes contrast from the tokens
  and fails if text drops below 4.5:1, a state below 3:1, blue starts to mean a state, or touch
  targets shrink.
- One font family in three weights. IBM Plex Sans Condensed from the mockups is dropped: it has no
  basic Cyrillic (only `cyrillic-ext`). xterm uses the shipped IBM Plex Mono instead of an unshipped
  `'JetBrains Mono'`.
- Rejected: a common 50rem radius ("pills"), a gradient on the accent, and the old accent `#74c2ff`,
  on which white text fails the threshold.
- Order of the next layers: the paste screen as a route -> list and inspector instead of StackList
  and the stack page -> a bottom dock for terminals and logs -> removing the old `.dark &`
  rules -> empty states and the first run. Replaced on 2026-09-13: the bottom dock was removed, and
  files and the log became tabs of the stack page.

### 2026-08-27: the stack creation layer in code

- `CreateStackSheet` opens over the list from the header button, from `Ctrl+V` anywhere outside an
  input field, or by dropping `compose.yaml` into the window. It replaces the "Docker Run" block of
  the home page.
- A command is recognised by its content and converted in the same field. The original text is kept
  and brought back by a button, because setting the value from code breaks the browser's native
  undo.
- The conversion report judges by the converter's real output, and the screen shows only the flag
  without which the service will not work; the rest are behind a button. Replaced on 2026-09-26: our
  own converter names every flag in its report.
- The handler used to cut the first line of the converter's output, which held its warning, and
  leave `name: <your project name>` in the user's file. Now only the generated name line is removed
  (`stripGeneratedProjectName`).
- A new stack is marked "just now" in the list for a minute instead of a toast.
- A failed configuration check keeps the layer open with the Docker Compose text, and the file stays
  on disk as a draft.
- Deliberately not done: abort, which needs a server handler that stops `compose up`, and progress
  per container. Both came on 2026-08-30: `abortCompose` and the state of each service while the
  command runs.

### 2026-08-28: list and inspector instead of the stack page

- A list row opens `/stack/<name>`: `StackInspector.vue` shows the state, one control group (Start
  or Stop, Restart, Update, and "More" with the compose file, `down` and delete), one attention line
  with its reason, the services table with per-service actions and a collapsed "Links and networks"
  row. The list stays beside it: two objects on screen, as `docs/design-system.md` requires.
- `/compose/<name>` became a full-width file editor without the lifecycle, delete, the attention
  reason or container cards: one action lives in one place, not two. Replaced on 2026-09-13:
  `/compose/<name>` redirects to the Files tab of the stack page.
- Russian plurals: `russianPluralRule` in `i18n.ts`, the index capped by the number of forms in the
  message. vue-i18n had applied the English rule ("2 сервисов").
- Our styles use `@use`, since Sass is removing `@import`. Two `@import`s stay: Bootstrap reads
  `!default` overrides only from the file's scope and is itself written with `@import`. Warnings from
  `node_modules` are silenced by `silenceDeprecations` in the Vite config.

### 2026-08-28: a bottom dock for output

Replaced on 2026-09-13: the dock was removed; stack output moved to the "Logs" tab and, on
2026-09-14, shells to the "Terminal" tab. What still holds:

- Each session has its own terminal name from the shared helpers, so `sh` and `bash` do not share a
  PTY.
- Hidden sessions use `v-show`, not `v-if`: unmounting `Terminal` sends `terminalLeave` and would
  kill the shell.
- `joinCombinedTerminal(stackName)` mirrors `leaveCombinedTerminal`. It takes only a stack name, and
  `Stack.getStack` rejects anything that is not a stack directory, so no command passes through it.

### 2026-08-28: the interface brought to the design system

- **Blue no longer means state.** `statusColor()` returned Bootstrap variants, so "running" was the
  blue of interactive elements. `statusStateName()` replaced it, and every state is drawn by one
  component, `StateChip.vue` (a `--state-*` dot plus a word), instead of three different ways.
- **Themes are not duplicated.** The ten `.dark &` rules and a 190-line block are gone; one table
  maps each `--bs-*` variable to a token. It cannot live on `:root`: dark tokens are on `body.dark`,
  and on `:root` it resolved to light values and turned dark-theme headings almost black. The one
  exception under a theme selector is three Bootstrap variables with an embedded SVG.
- **Components carry no colours of their own.** `ArrayInput`, `ArraySelect` and `NetworkInput`
  used `$dark-bg2` unconditionally and were dark in the light theme; they and the remaining screens
  moved to tokens.
- **`--surface-console` is the same in both themes:** CodeMirror and xterm highlighting is drawn
  for a dark background, and on white the red YAML keys failed the contrast threshold. The dimming
  under a layer is the `--scrim` token, since `backdrop-filter: brightness()` barely worked in the
  light theme.
- The services table is a panel that scrolls inside itself instead of running off a narrow screen.
  Buttons have one style definition, in `main.scss`.
- The external network toggle is a `button role="switch"` with `aria-checked`; a tab's close cross
  is not inside the tab button, because a button inside a button cannot be reached by keyboard; the
  create layer traps focus and returns it to the button that opened it.
- `test/frontend/design-tokens.test.ts` guards the system: a colour literal (`#rrggbb`, `rgba()`)
  in a component's styles fails, and so does a theme-selector block holding anything but `--bs-*`
  variables with an embedded asset.
- Left for later: a diff before writing for the network toggle.

### 2026-08-28: the list row and the inspector brought to the mockup

The build had the frame of the agreed mockup ("Pasted and deployed", 2026-08-27) but not its
content: the row showed only a dot and a name.

- **The server sends what the row needs.** `summariseServices()` in `common/compose-status.ts`
  judges each service from the same host-wide `docker ps`: unreadable output stays "unknown", a
  declared service without a container is "stopped", exit code 137 is "attention".
  `backend/stack-source.ts` reads the directory's Git source without network access and caches it
  for a minute, or the 10 second cron would run git over every stack. Credentials are stripped from
  the address, because the interface shows it.
- **The row** got the agent, a source chip ("Git · in sync", "Git · -2", "local"), service chips
  with "+N" and an updates column. Hidden services are named in a tooltip: silent truncation is not
  allowed. Replaced on 2026-08-31: these columns moved to the work area.
- **Filters** are buttons with `aria-pressed`, counted over the whole list, or a button would change
  its own number when pressed. The filter lives in the address, so the header's "needs attention"
  counter leads straight to that slice. Search matches service names too: the owner remembers
  "gotenberg", not the stack it is in.
- **The layout followed "Frame 1"** of the mockup, a wide list and a 400 px inspector. Replaced on
  2026-08-31 by a 320 px navigator.
- **The inspector** got origin chips (agent and directory, service count, image registries from
  `common/image-source.ts`, the source), the reason with "Logs of <service>" and "Restart <service>"
  buttons, memory use from `docker stats`, uptime, and the age of the state ("N s ago").
- **No invented data:** where no image check existed, the updates column showed a dash saying so
  (the registry check came on 2026-08-30). Availability waited for stored observations (next entry).

### 2026-08-28: availability without lies

- **A change is stored, not a sample.** `stack_observation` (migration `2026-08-28-1200`) gets a
  row only when a stack's state differs from the last one recorded. A row per 10 second tick would
  be millions of rows a month with no new fact in them. History is kept 31 days and cleaned at most
  every six hours.
- **The cron records, not the list broadcast.** The list is built only while a signed-in client is
  connected, so recording from `sendStackList` would measure how long the owner watched the screen.
  `observeStacks()` runs from the cron regardless of sockets.
- **`computeAvailability()`** in `common/availability.ts` is a pure function with these rules:
  under half an hour of observation is "not enough data", with how much was observed; a clean full
  window is "no incidents · 24 h", not "100%"; one long outage is one incident; a gap in
  observations reduces coverage and never counts as healthy; a stopped stack gets a duration
  ("stopped N ago"), not a share; `ATTENTION` and `UNKNOWN` are never healthy.
- **Windows** are 24 h, 7 d and 30 d through `stackAvailability`, and the server accepts only these:
  an arbitrary number would let a client order a scan of the whole history. A partly observed window
  says so ("Data collected for 2 days of the selected period"), or the percentage would look
  complete.
- **Running time is in the interface language.** `common/docker-time.ts` parses Docker's "Up About a
  minute" into milliseconds; a phrase that does not parse is not shown.
- **`frontend/src/format.ts`** formats percentages and durations the same everywhere and takes the
  language explicitly, or the panel would write "94,2%" or "94.2%" depending on the machine.
- Left as a known limitation: no availability for an agent's stacks, whose lists reach the client
  socket, not the server cron.

### 2026-08-28: matching the mockup by picture

The owner said it still did not look like the mockup. The mockup and the build were captured in one
browser and compared in one picture: the difference was in character, not data.

- The row became one line with the state word in hidden text and the dot's tooltip, so names line up
  as in the mockup; availability in words and the attention bar kept colour from being the only
  signal. Replaced on 2026-08-31 (two-line navigator) and by 2026-09-15, fourth pass (the rail row
  carries a state chip).
- The list is a flat area with a divider, not a card with a shadow, so rows read as a table.
- `AttentionStrip.vue` above the list names the problem stacks with their reason and leads to
  `?filter=attention`. After the home page was rebuilt no screen used it; it returned on the
  overview on 2026-09-15 (second pass).
- A dense header with the tabs "Stacks", "Console", "Settings", "N need attention" and "updated N s
  ago", counted from the arrival of the list, not from a render timer.
- The dock was always visible, with "+ session". Replaced on 2026-09-13: the dock was removed.
- "Update" became the inspector's primary action ("Update from Git" when Git is behind); service
  actions appear on hover and on focus.
- The mockup's "Containers" and "Agents" tabs were not built: no screens stand behind them, and
  empty ones were not invented.

### 2026-08-30: updates, abort, empty states and the local setup

- **Update preview.** `stackUpdatePreview` answers what is known before a run: the working copy
  (lag, uncommitted edits) and the registry's answer per image. "Update" opens the preview and a
  second button runs it: the design document forbids mixing the two states.
- **Compare like with like.** On the containerd store an image `Id` is the manifest digest, so
  comparing it with the config digest called a fresh image outdated. Local `RepoDigests` are
  compared with `docker buildx imagetools inspect`; without buildx a fallback covered
  single-platform images only, and the rest stayed "unknown". Replaced on 2026-09-24: the registry
  API is asked directly, since the published image has no buildx; on 2026-09-17 images were polled
  four at a time with an 8 second limit per call.
- **Abort** ("Stop"): `abortCompose` ends only the stack's own compose terminal, whose name the
  shared helper builds, so it cannot close anyone else's session. The per-service run block shown
  with it was replaced on 2026-09-14 by the run strip and the "State" column.
- **Empty states** are one component, `EmptyState.vue`: an empty list offers to create a stack, a
  filtered one to clear the filter. The disabled console pointed to an environment variable; since
  2026-09-24 an owner turns it on in Settings.
- **Running the project:** `docker-compose.yml` for production (`restart: unless-stopped`),
  `docker-compose.local.yml` for development (no restart, ports 5000 and 5001, `node_modules` in its
  own volume), `local.sh`, which recreates only its own compose project, and `.env.example` with
  every variable.
- **`npm ci --ignore-scripts` in `docker/Dockerfile`:** node-gyp for better-sqlite3 failed, because
  the base image has neither python nor a compiler. The packages ship prebuilt binaries
  (`better-sqlite3/prebuilds`, `node-pty-prebuilt-multiarch/prebuilds`).

### 2026-08-31: the layout rearranged so the work has room

The owner found the interface uncomfortable: the list was smeared across 1600 px while the
inspector with the actions was squeezed into 400 px. This overrides the "Frame 1" proportions: the
mockup was drawn before the panel had anything to do.

- **A 320 px navigator**, two lines per stack: the name with a state dot and a meta line. The row's
  columns moved to the work area, where images, ports and usage have room. The meta line with
  availability went by 2026-09-15 (fourth pass): the rail row carries a state chip.
- **The work area takes the rest, capped at 1100 px,** with tables as wide as their content: a
  full-width table put usage 700 px away from the name.
- **The empty work area held the create brief** (`CreateStackSheet` in an `inline` mode, one logic
  in a different shell) instead of counters and a button that duplicated the header. Later entries
  show the home page rebuilt around the stability overview (2026-09-15) and a separate "New stack"
  page (2026-09-16).
- **Two availability captions lied:** "99.9% · 0 incidents", where a stop lowered the share (now the
  percentage alone, explained in a tooltip), and "100%" for a share below one (the percentage rounds
  down, because there was downtime).

### 2026-09-13: files and logs became tabs, the bottom dock removed

The owner said the files led away to another page and the log popped up from below and got in the
way. The chosen option: no bottom panel at all.

- **Overview, Files and Logs are tabs of one stack page.** Their routes render the same
  `StackInspector.vue`, so the router reuses the instance and only the work area changes. A static
  path segment outranks a parameter in route scoring, as it already did for `git`.
- **`/compose/<name>[/<agent>]` redirects** to the Files tab, so old links keep working;
  `Compose.vue` has an `embedded` mode without its own header and tabs.
- **`TerminalDock.vue` was deleted** with `$root.openStackLogs`, `openContainerShell` and
  `dockHasLogs`. Sessions survive a move between tabs of the same stack (`v-show`, so `Terminal`
  does not send `terminalLeave`) but not to another stack: an open stack shows its own log. The
  shared `StackSessions.vue` was replaced on 2026-09-14 by separate Logs and Terminal tabs.
- **The files panel uses `v-if`,** so polling and editor state are destroyed. Unsaved edits are
  asked about in the inspector's `beforeRouteUpdate` / `beforeRouteLeave`, delegated to the embedded
  `Compose`: in-component guards fire only on the route component.
- **xterm in a hidden tab fits itself to a garbage size,** so showing the log refits it.

### 2026-09-14: logs and files brought to the mockup

The owner showed mockup frames of the log, the files and the Git comparison; the first two were
brought to the third. The rules come from `source.css` of the frozen mockup export (removed from the
tree later, see 2026-09-26: documentation cleanup), expressed in our tokens; the mockup is never
imported into the application.

- **One grid on every tab:** `inspector-grid`, the main column plus a 265 px source panel on the
  right.
- **The log is a card** whose header states the connection in words (`StateChip`): a local stack
  watches its own socket, an agent's stack that agent's status. The caption says whether the shown
  session takes input, because output and a shell look alike.
- **`ResizeObserver` watches the console area**, since the old xterm grid overlapped the caption
  after a resize; the area clips its content so a lagging canvas does not cover text.
- **Files are file cards:** the name in monospace, an "On server" mark, copy and the editor actions
  in the header, and the caption "Source text, comments included". The env file looks the same.

### 2026-09-14: the log separated from the container terminal

The owner: the log is for output and errors; a bash or sh shell is something else and belongs in its
own tab after the log.

- **Four tabs:** Overview, Files, Logs, Terminal, all on the same `StackInspector.vue`.
- **`StackJournal.vue` is stack output only** and never takes focus: it accepts nothing, and focus
  would lead the keyboard away from the page. Its caption says so ("The stack log is read only").
- **`StackTerminals.vue` holds container shells:** session tabs with close, a caption that commands
  run inside the container, and a choice of service instead of a black rectangle while no shell is
  open.
- **"Open shell" in a service menu leads to the Terminal tab** and gives it input. The row's logs
  button still led to the log; changed on 2026-09-17, when the row's terminal icon opens a shell and
  the log moved under the three-dot menu.
- Both panels stay mounted on other tabs: the log would restart its output and the terminal would
  lose its shells.

### 2026-09-14: command progress shown on the stack page

The owner asked where the output of start and restart (`[+] Running 2/2`,
`✔ Container ... Removed`, `[+] Pulling 13/13`) is shown. In Dockge 1 it is a console under the
action buttons, and it stayed there.

- **Progress sits under the stack header, above the tabs** (`StackProgress.vue`), visible from any
  tab and covering nothing. A window over the page was rejected: it hides what the command was run
  for and blocks moving to another tab meanwhile.
- The panel opened by itself and closed only with its button. Replaced the same day by steps, then
  by the run strip (entries below).
- **One output, one terminal.** Only the Files tab listened to the progress terminal, so the overview
  never showed the output. The embedded editor no longer creates it (two terminals with one name
  take lines from each other) and reports deployments with `run-start` / `run-end`. Actions on one
  service write into the same terminal.
- The root class avoids `.progress`: in Bootstrap that is a 1rem loading bar, and it squashed the
  console into a strip.

### 2026-09-14: progress speaks in steps, the terminal waits its turn

The owner: "the terminal puts people off, but the terminal is needed for the work". As in Ubuntu,
the terminal does not appear until the person calls it or an error happens.

- **Steps instead of output.** `common/compose-progress.ts` parses the stream into resources: kind
  (container, network, volume, image), name, verb, seconds. Compose redraws its block in a TTY, so
  lines merge per resource and the last word wins. An unknown verb is plain output; image layer
  lines are skipped.
- **The xterm buffer is read, not the socket:** the buffer already holds the redrawn screen, and
  wrapped lines rejoin by `isWrapped`. Parsing runs on `onWriteParsed` with a 120 ms delay. The
  terminal stays mounted, since it is bound to the socket by name.
- **Motion answers an event, never decorates:** a row slides in when a resource comes up, a running
  step breathes, the result appears as a tick or a cross, a thread fills by compose's own count.
  Under `prefers-reduced-motion` endless animations stop and the state stays in the icon and the
  word.
- The output opened by itself on a failed step. Replaced the same day: the full output is a window
  that never opens by itself (next entry).
- The run block on the overview was removed as a worse duplicate, with the keys `serviceQueued`,
  `serviceWaitingHealth` and `serviceHealthy`.

### 2026-09-14: the table tells the state, progress is one line, output is a window

The owner: "what if this showed the active status of start and restart, and on errors you press a
button and a window with the full start log pops up? so the panel does not get in the way every
time, since the status is basically duplicated". The duplication was real, but partial: the table
has no networks, volumes, image pulls, total time or abort, and the Files, Logs and Terminal tabs
have no table. So the duplicated part went to the table and the rest shrank to one line.

- **The "State" column reads the compose steps** while a command runs: the chip says "creating",
  "starting" or "started" and its dot breathes. The colour follows the step: in progress is
  attention, done is running (stopped for "stopped" and "removed"), failed is failure.
  `TAIL_DELAY` (4 s) after the end the word returns to the Docker reading, or the table would lie
  about what happened after the command.
- **Compose names containers, not services.** A step matches the container name from `docker ps`,
  then `container_name` from the file, then compose's own `<stack>[-_]<service>[-_]<number>`. An
  image pull matches by service name and yields to a container step.
- **The run strip** (`.run-strip`): the result mark, the command, the current step, the step count,
  seconds, abort ("Stop"), "Show the output", close. It leaves by itself 4 s after a success; after a
  failure it stays red and names the failed step. The wrapper is `display: contents`, so an empty
  strip leaves no hole in the page column.
- **The full output is a Bootstrap modal** with permanent markup (as `Confirm.vue`), so its terminal
  never unmounts or loses the socket; the grid is fitted on `shown.bs.modal`. It never opens by
  itself, even on a failure: the person presses the button, as the owner asked. "Last command output"
  in the stack's "More" menu reopens it.
- The verbs live in `frontend/src/progress-labels.ts`, shared by the strip and the services table.
  `StateChip` has a `busy` flag; under `prefers-reduced-motion` the dot stops and the word stays.

### 2026-09-14: one panel anatomy on the Files, Logs and Terminal tabs

The owner: "look at the files, the logs and the terminal ... the design seems very inconsistent".
Measurements confirmed it: headers of 49, 35 and 33 px in three styles, two icon families, `h4`
headings next to names in headers, a shadow on one panel only, radius 10 against 7, mixed button
sizes, Bootstrap palette badges, a `select multiple` next to checkboxes, a red delete button in every
row, two names for one action, a 50vh console over a quarter of an empty page.

- **One anatomy** in `main.scss`: `.panel` (border, panel radius, no shadow), `.panel-bar` (control
  height, outline icon, name, `.panel-meta` on the right, `btn-sm` actions), `.panel-body`,
  `.panel-console`, `.panel-foot`. The Compose and env files, "File selection", "Secrets",
  "Containers", "Extra", "Networks", "General" on stack creation, the log, the terminal and the
  source all use it; the per-component copies were deleted.
- **The header carries the name.** No `h4` above forms; a panel's save button sits in its header and
  is enabled only when there is something to save. Header icons are outline `InterfaceIcon`s.
- **A list inside a panel is rows** divided by thin lines, not nested cards. The services that
  receive a secret are chosen with checkboxes, like env files. Delete is a red word on a normal
  button (`btn-normal.btn-danger-text`).
- **One word, one action.** The terminal button is "Open shell", as in the service menu ("+ session"
  and `sessionNew` are gone). The log header is "Logs of <stack>", after the tab.
- **The console grows to the bottom of the page:** `.work-column` is a flex column, and the Logs and
  Terminal tabs take `flex: 1`. All tabs share the `tab` motion.

### 2026-09-15: pass over every screen - one grid, one control, a phone without sideways scroll

The owner asked to go through the whole design and make it convenient and beautiful. Every screen
was checked in both themes at 1440 px and 375 px on the test scene.

- Global overview: one table per server with columns named once, each stack a group inside it; a
  table per stack repeated the headings and the columns did not line up.
- The console takes its colours from tokens: xterm's own pure black left a seam in the light theme.
  Text keeps off the panel border, because lines pressed against it read as cut off.
- `ThemePicker` is one form control with a `compact` flag. The account menu is grouped (stacks,
  settings, then theme and sign-out): a theme picker among the links read as one more link.
- One call to action per frame: "Open shell" appears in the terminal panel header only once a
  session exists; before that the service picker in the panel body is the only offer.
- Phone: the stack tab bar scrolls by itself instead of the page, and tab icons go below 480 px,
  because the name matters more.
- **Env files became reachable.** The owner asked how to edit env at all: the env panel existed only
  in edit mode, so `.env` could not even be opened, and no env file could be created. Modelled as a
  hierarchical state machine of the tab (`Add` / `Manage{View, Edit{Structured, Text-only}}` plus an
  orthogonal `processing` region): a child state was creating an entity instead of changing
  behaviour, so the panel moved up to the level of compose and the mode only disables it. When
  reading it is shown only if the active file exists, or the screen would promise a missing file; an
  empty file says so in words, because an empty black box read as a failed load.
- **Adding an env file is its own step.** "Add env file" calls the existing `saveEnvFile`, whose
  server checks already refuse non-env names, `..`, absolute paths and symlinks. Create, include in
  substitution and open stay three steps: in edit mode `saveFileSelection` does not reread the texts,
  so a combined action would show the new name over the old text and save that text into the new
  file. While the selection is unsaved the form is closed ("Save the file selection first."): an
  unfinished transition blocks the next one.
- **Truncation shows what it hides**, as the owner required when allowing it. `v-ellipsis-title`
  sets `title` only while the text is really cut, since a tooltip repeating visible text is noise,
  and reads `innerText`, since a media query hides parts of some labels on the phone.
- **Reference screenshots.** The owner: "keep a reference; treating every prompt as the reference is
  bad practice". `npm run test:visual` compares 28 committed references (nine screens in both themes,
  five of them also on a phone). Approval is a separate command, `npm run test:visual:approve`: a
  screenshot updated together with a change stops being a reference. The suite has its own
  configuration, apart from E2E, which needs Docker and would fail it for unrelated reasons. No
  socket, a fixed clock, an explicit theme and no animations keep the frames deterministic.
- **Two console defects seen only live.** xterm measures the cell width once, on open, and could
  measure the fallback font before IBM Plex Mono loaded; the terminal now opens after
  `document.fonts.load` (limited to three seconds on 2026-09-16). A fit requested before opening
  bound a `FitAddon` to nothing and left the shell wider than its panel; the fit now waits for the
  terminal.
- **A live instance for review.** The test scene answers with fixtures and misleads both ways: on 14
  September it showed a failure that did not exist, because it returned one shared inventory object
  where a real socket delivers a fresh copy. `extra/seed-review.ts` lays out four edge-case stacks in
  `.tmp/review` (inside the project, ignored). The owner is created by the interface's own handler
  with a random password, then `disableAuth` turns sign-in off, so no password is typed into a
  browser; only images already present locally are used. It found both console defects, and a file
  on disk that fails the allowed-name list and silently vanished from the files screen
  (`SAFE_SEGMENT` rejects Cyrillic by design; the screen could not say so).

### 2026-09-15: second pass on a live instance - one state vocabulary, one attention box

On a live instance with real containers, where mismatches show because elements stand side by side.

- A disabled button has no fill in any variant, only a thin border and a muted label: a blue
  disabled primary promised weight it did not have. Bootstrap's opacity is cancelled, because it made
  the label's contrast depend on what lay beneath.
- `.panel-title` sets its own size instead of taking it from the tag (22 px next to 14 px).
- The settings column is limited to 720 px: at 1440 px half a screen separated a label from its
  field.
- After a failed read the MCP section shows the cause and a retry. It used to render a form of
  defaults, and "Save" would have written them over the real settings.
- A file whose name fails the allowed-name list is shown with the reason and what to do, instead of
  vanishing. The list itself is not relaxed.
- A zero in the state counts is muted: an orange "0 Needs attention" read as a warning.
- One state vocabulary: the abbreviations in the Russian services table are gone, and stack, service
  and container name a state with the same words.
- A state chip's capitalisation is a `::first-letter` rule in `StateChip.vue`, not a second set of
  strings: the same words stand mid-sentence in the progress line, and doubling the catalogue for
  case is not worth it.
- Attention is drawn by one box in `main.scss`; the copies on the home page and the stack page had
  already diverged.
- `AttentionStrip.vue` is back on the global overview, above the state counts; nothing had imported
  it since the home page was rebuilt. The counts count containers, the strip names stacks with
  reasons.
- The sign-in card is centred under the header. In the reference scene `/login` and `/setup` no
  longer sit next to the stack rail, a layout the application never has, and one stack is in
  `ATTENTION` so that the state reaches a screenshot.

### 2026-09-15: third pass - room for output, one brand mark, one checkbox

- A page that is one console fills the work area to the bottom (at least 280 px): a height in rows
  left a quarter of the screen empty, half on a tall monitor.
- The console header names the server (the own host or the agent's display name): "Console" above
  "Console" said nothing, and on an agent it hid whose machine it is.
- Deleting the last active owner is disabled, with the reason in the caption: the server refuses it
  anyway (`authLastOwner`).
- The MCP section tells a refused access from a failed read. `/api/mcp` requires a real session even
  with sign-in off, so a local instance got 403 and advice about the owner password. A 403 has its
  own reason and no retry, which would return the same answer.
- `.form-check` is one rule in `main.scss` after the Bootstrap import, where it wins by order; the
  per-screen copies are gone. Bootstrap's float with a negative margin pushed the box past the panel
  edge in settings rows.
- The editor box keeps room for six lines, so an empty file still reads as a place to write.
- The brand is one component, `BrandMark.vue`, in the header, on first run, in About and, for the
  first time, on sign-in, as the design system promised. It read "dockge2" in one place and "Dockge"
  in another, and first run lost the generation number. The number is a share of the font size
  (73%), not a scale token, so the proportion holds at every size.
- A count in a panel header stands further from the buttons than they from each other, or it read as
  a button's label. A server name takes a capital in the agent list but not mid-sentence in the stack
  header.
- The review seed writes `disableAuth` with type `general`, the only type Settings reads; the
  security screen showed "Disable Auth" off while sign-in was off.

### 2026-09-15: fourth pass - the phone and state markers

At 390 px, and wherever an element shows its own state: where am I, what is selected, where to press.
A script checked fourteen routes for sideways scroll, elements past the right edge, truncated text
without a tooltip and touch targets under 30 px.

- The rail marks the open stack on all its tabs (`.active` and `aria-current="page"`): the tab routes
  are siblings of the overview, so `router-link` marked the stack only there.
- A long name in the rail gets `v-ellipsis-title`; the tooltip on the whole row, which repeated the
  visible text, is gone.
- The services table header stands above the scroll area, not in the `caption`: on the phone the
  count, check time and column menu slid away with the table. A caption stays for screen readers.
- On a narrow screen the attention strip puts its action on its own line: in three columns a reason
  had ten characters, and words broke in half.
- The phone stack drawer has one scroll area instead of three, so a finger no longer lands in a
  random one, and the create button under the list is visible again.
- Small controls grow to the touch height on a narrow screen, and the external network toggle's
  target is the full control height.
- The current dropdown item is a soft accent like the rail and settings; a solid fill read as hover.
- Every stack menu item has an icon; "Update images" had none, and the left edge went in steps.
- A failed MCP read uses the same box as a disabled console: the title names the state, the hint the
  cause, and a retry stands only where it can help.
- The sign-in panel is "Signing in" instead of "Advanced": its one button is about signing in.

### 2026-09-15: fifth pass - keyboard, contrast, heading structure

Tab order on fourteen routes, the contrast of every visible text on its actual background in both
themes, and the heading structure of fifteen screens.

- The log no longer traps focus. xterm took focus on opening any terminal and caught Tab, so the
  keyboard could not leave the log output. Only terminals one types into take focus; output has
  `disableStdin` and gives Tab to the browser. A container shell keeps Tab for completion.
- The console and the editor draw a focus ring on their box: xterm's input is a hidden one-pixel
  field and `cm-content` has no border. On the console it is an `::after` layer, because xterm's
  canvases cover an outline.
- A state is text, so it needs 4.5:1, not 3:1: states stand as words next to counts, in the
  stability verdict and in the Git edit line. `--state-running` gave 4.36, and 3.78 on the sunken
  surface. Four states and `--text-faint` moved a few units in lightness; the test checks 4.5:1 for
  six states and four text tokens on five surfaces.
- A panel header is a heading (`h2`, the service name `h3`); it was `h2` in Settings and a `span` in
  the work area, and the new stack page went from `h1` to `h4`. The look comes from `.panel-title`,
  not from the tag.

### 2026-09-15: stack backups go to the backlog

A question about PostgreSQL inside Dockge ended as a requirement for backups. PostgreSQL is
rejected: Dockge is a control plane, and its database holds users, settings, agents and status
history, not the truth about stacks, which lies in the stacks directory and in Docker itself. An
embedded database server would add a second storage system, a bootstrap paradox (a stack with the
database starts what it is meant to store), `pg_upgrade` between major versions, a new secret, and
the loss of "copy the directory, move the instance". SQLite stays.

The owner on backups: they must be manageable and enabled per stack, because a control node or a
couple of containers with Telegram bots do not need them; the task needs design, system logic and
disk space, so it goes to the backlog.

- What is copied is the recipe, the data and the image version, not the container; `docker commit`
  and `docker export` are not suitable. Recorded before implementation in "Stack backups" under
  Requirements and in "Implementation plan". Points to build on: `common/stack-files.ts`,
  `backend/stack-git.ts`, `common/image-digest.ts`; the code has no model of volumes.
- Status: no decision, no decomposition, do not start. The first question is the consistency of a
  running service's volume.
- Small items proposed earlier and never agreed stay unaccepted: a warning about a network data
  directory in the README and `docker-compose.yml`, and a snapshot of the panel's own database with
  `VACUUM INTO`.

### 2026-09-15: readiness for production tests

The owner asked how ready the current state is for tests in production; it was checked by running
things, not from memory.

**Green.** Lint, strict types, unit tests, Docker integration and the visual suite. The production
backend serves the built frontend itself, the database and `bootstrap-token` are created `0600`, the
image builds (753 MB) and comes up healthy, and without the Docker socket the panel degrades with
warnings instead of failing.

**Red.** `npm run test:e2e`: 13 of 40 failed on a clean bench. The tests were at fault, with
selectors gone stale after the redesign, except one failure that was behaviour: choosing another
stack closed the log tab and returned to the overview. Until fixed there is no browser safety net,
and the CI `e2e` job on `main` is red.

**Fixed during the check.**

- `emptyOutDir: true` in `frontend/vite.config.ts`: the build directory lies above the Vite root, so
  Vite never cleaned it, and each build added a bundle to the old ones, 1833 files and 284 MB in the
  image. After the fix, 183 files and 5.0 MB.
- `familiarOverview` became "Global overview": two English links, to the global overview and the
  stack tab, were both "Overview", the same to the ear and to a screen reader.
- `express` and `npm audit fix` closed two `qs` advisories, 0 vulnerabilities in production
  dependencies. `npm audit fix --omit=dev` removes the dev dependencies from `node_modules`, so
  `npm install` is needed after it.

Status: ready for an internal test in a container on one's own machine, not for production tests by
other people. Mandatory before those: e2e, since without it there is no gate, and the upstream brand
and addresses, since whoever installed by the README would not get this fork. Also open: the
upstream base image, `extra/seed-review.ts` (which sets `disableAuth`) inside the image, hashed assets
not served as immutable, and stale plan checkboxes. All were handled the next day (below).

### 2026-09-16: the production readiness plan carried out

Queues 1-3 of `docs/plans/2026-09-16-prod-readiness-fixes.md` (deleted with the other finished plans
on 2026-09-26).

- **e2e green**, and no check was weakened: each new selector proves the same property as the old
  one, and language-dependent text is matched by a regular expression over both languages, not by a
  fragment of the English string. The container terminal test types with a delay: xterm lost the
  order of characters typed instantly, and the failure looked like a bash error.
- **A tab change no longer recreates the inspector.** `<router-view :key="$route.path">` recreated the
  inspector on every tab change, since all stack tabs are one component on different paths: an open
  container shell died and the log was reread from scratch. Stack tabs are keyed by the stack's
  identity; the server address stays in the key, because it changes the whole data source.
- **The update command was silently useless.** It ran `docker compose pull`, but the image was built
  locally and nothing was published. It became `git pull --ff-only`, `npm ci` and a frontend build,
  `docker compose config --quiet` before the restart, and `docker compose up -d --build --wait`, so
  it does not leave an undefined state. Changed on 2026-09-18: the frontend is built inside the
  image, and `npm ci` and the build left the update. The command was later replaced by
  `update-dockge.sh` and the Go updater (see "Implementation plan").
- **Brand and addresses.** `package.json` is `dockge2` 2.0.0 with images `mazixs/dockge2` (replaced
  on 2026-09-19: the first publication is `0.0.1`, and `2.0.0` waits for the first stable release).
  The docs and `.github` templates point to this repository. The root `compose.yaml` is deleted: it
  installed `louislam/dockge:1` and shadowed the documented `docker-compose.yml`. The version check
  reads this repository's releases instead of upstream's and is off by default: it is an outgoing
  request the administrator did not ask for.
- A deliberate deviation from the literal criterion that `grep -ri louislam` finds only the licence:
  the fork attribution and the original MIT notice, the real third-party image
  `louislam/uptime-kuma:1` in a template, and the code origin link in `extra/healthcheck.go` stay.
  Erasing them would hide the fork's origin and break a working template.
- **State recorded.** The work since 31 August, uncommitted until then, was split into commits by
  meaning and tagged `v2.0.0-rc.1`; the production test runs from the tag. Nothing was pushed.
- **Own base image.** `docker/Dockerfile` builds from `mazixs/dockge2:base` and
  `mazixs/dockge2:build-healthcheck`, built once locally from the recipes already in the repository,
  so the release build no longer depends on someone else's namespace. Replaced on 2026-09-19:
  `docker/Dockerfile` builds everything itself from the official `node` and `golang` images, with
  no base image of our own.
- **Image cleaned.** `.dockerignore` excludes docs, tests, CI and developer files, and above all
  `extra/seed-review.ts`, which starts a server with authentication off.
- **Static cache.** `/assets/` is served `immutable, max-age=1y`, since the names carry the hash, and
  `index.html` `no-cache`; otherwise a browser could open old markup pointing at deleted bundles after
  an update.
- **Plan checkboxes reconciled.** Tasks 0, 1, 2, 4 and 8 of the product-dashboard plan are checked
  against their acceptance criteria; 3, 5, 6, 7 and 9 stay open with what is not closed in each,
  which is more honest than checking everything from the journal. They moved to "Interface and
  Docker overview: open tasks" on 2026-09-26.
- **README on production deployment:** data on a local disk and outside the Git copy, `PUID`/`PGID`,
  a reverse proxy with `DOCKGE_TRUST_PROXY` and `DOCKGE_SECURE_COOKIES`, the update command, rollback
  to the previous image tag.

Not done: the production test on a clean host. There is none, and some steps (a host reboot, TLS
behind a real proxy) cannot be reproduced on the working machine.

### 2026-09-16: production test from the tag - nine steps and two defects

As far as it can be reproduced without a clean host: a local bare repository as `origin`, a clone of
the tag inside the project with its own port, data and stacks directories, and the real project name
`dockge2`, or the update command would update the wrong panel. No password was typed into a browser.

**Passed:** install by the README (healthy in 17 seconds); first run with `0600` files and the owner
created with the one-use code; a stack converted from `docker run` and deployed; the stack log across
a restart; secrets behind the password, metadata only in the list; a hand edit on disk read back; the
update from a detached HEAD in 28 seconds with the owner and stacks intact; rollback to the previous
image; and a TLS proxy (nginx, self-signed) with a `__Secure-` cookie, websocket, deploy and a
service shell through it, and a foreign origin refused. The data files belong to root, because the
process runs as root; `PUID`/`PGID` affect only stack files, as the README says.

**Two defects, fixed.**

1. `package-lock.json` still said `dockge` 1.5.0, so the first `npm install` by the README dirtied
   the working copy, and the update refuses a dirty copy on purpose, so that `git pull --ff-only`
   does not stop halfway. A deployment made exactly by the README could not be updated by the
   documented command. The lockfile is regenerated as a clean install makes it.
2. The socket.io handshake compared `Origin` with the `Host` the process sees, which a reverse proxy
   rewrites: the HTTPS page opened, the websocket was refused and the panel stayed "connecting"
   forever. No setting helped; the only way out was `DOCKGE_WS_ORIGIN_CHECK=bypass`, removing the
   protection instead of configuring it. The handshake now uses the trusted origins of the
   authentication requests (the requested address, the public URL, the extra origins, and proxy
   headers only from a trusted proxy).

**Documentation.** The README promised that the previous image stays under its tag. It does not:
`DOCKGE_IMAGE` is one fixed tag, and `docker compose up --build` moves it to the new image, leaving
the old one unnamed. The rollback section now says to name the image before updating, and a working
nginx fragment is added.

**Not done.**

- A host reboot: the machine is a working one. Checked indirectly: `unless-stopped`, and Docker
  starts at boot.
- Recovery after a process crash is not proven: Docker treats `docker kill` as a manual stop, so the
  policy does not fire, and a SIGKILL from inside does not kill PID 1 in its own namespace. Another
  way of checking is needed.
- An install by someone who did not write the code: the real production test, left to the owner.

**Incident.** A substring `grep` during the recovery check matched a container of an unrelated
project on the same machine, and it was killed with the test containers; it was restarted with
`docker start`. Rule: select containers by exact name or a project filter, never by substring.

### 2026-09-16: the work goes to the repository, which would have released on its own

The task: merge everything into `main`, make versions and addresses lead to this fork, release
nothing, and make the tests runnable from the repository.

- **The main finding.** `nightly-release.yml` ran on a nightly schedule and published images to
  Docker Hub and ghcr: "release nothing" would have broken by itself the first night after the push.
  The schedule is removed, only a manual run is left; no other workflow publishes anything. The
  workflow itself was removed on 2026-09-25; `release.yml` on a `v*` tag is the only publisher.
- **Release path.** `build:docker` also tagged a stable build `beta` and `nightly`, one image posing
  as three lines. `update-version.ts` committed with `commit -a`, picking up whatever lay in the
  working copy, set a lightweight tag without `v` and ignored the exit code, so a failed commit was
  tagged as a good one; it now commits only `package.json`, tags annotated with `v` and notices a
  failure. `mark-as-nightly.ts` replaced the version all over the README; it touches only the
  manifest now.
- **Types for `extra/`.** The release and update scripts were never type-checked, and an error there
  shows only to whoever tries to update the panel. `extra/` is in `tsconfig.json` now.
- **CI on Linux only.** The panel drives Docker through the host socket and runs `docker compose`; it
  cannot work on Windows or macOS and the README does not promise them, so a red run there says
  nothing. `tsconfig.json` is excluded from `json-yaml-validate`: it is JSONC, and its comments
  explain the settings and are worth more than that check.
- **Ignore files.** `certs` and `docker-compose.override.yml` are ignored: they appear for anyone who
  deployed by the README.
- **Addresses.** Every product address leads to this repository. Upstream mentions stay on purpose:
  attribution, the MIT licence, quotes of upstream issues in historical plans, a real third-party
  image and a code origin link.
- **Documentation before publication.** The repository is public, and the first push would publish
  all of it. The design notes held absolute paths of the author's machine and the name of an
  unrelated project next to the test stacks; both were removed, the meaning of the notes kept.
- **Default branch.** `main` was pushed and made the default instead of `master`, which stood at the
  fork point: a clone by the README would have given upstream code of version 1.5.0. No tags,
  releases or images were published.
- **The first real CI found three things invisible locally**, each a real defect:
  1. `json-yaml-validate` on `tsconfig.json`, above.
  2. Docker integration. A test starting a whole panel with `NODE_ENV=production` failed because the
     backend exits without `frontend-dist/index.html` and the CI job had no frontend build; locally
     one was left from earlier runs. The test also discarded the child's output, which now goes into
     the error. Two tests waited for a one-shot container with `compose wait`, which in Compose 2.38
     (CI) answers `no containers for project` for an exited container and in 5.5 (local) does not; a
     run without `-d` waits by itself in both.
  3. Browser tests: the first container terminal did not appear within 15 seconds. Not a flake: the
     terminal waited for its font without a limit, and on a cold profile the font did not arrive in
     time; on a slow link a user would wait at an empty box forever. The wait is limited to three
     seconds, and a late font recalculates the grid itself.
- GitHub CI is not a copy of the local machine: all three defects showed only there, and the font wait
  was a product defect, not a test one.
- **Confirmed.** Every job is green. A `git clone` of the public repository lands on `main`, `npm ci`
  leaves no change, and `npm run check` passes: the tests run from the repository.

### 2026-09-16: the owner's spoken report on the live instance - 28 items

- **The first screen waited in silence.** Availability and stack details were read stack by stack,
  28 sequential round trips on five stacks; they run in parallel now, with errors still handled per
  stack. The empty state no longer claims there are no stacks while the list is on its way: skeleton
  rows show until the first answer.
- **Stability metrics are links** to the stack list with the filter set; filters for running and
  unknown were added. "Unknown" is explained: after 90 seconds without a fresh observation the state
  is not considered known.
- **The Russian interface spoke English in eight places, not three**: untranslated words and six
  keys missing from the catalogue, where `$t()` prints the key name in every language. Two guard
  tests check every `$t("...")` in `frontend/src` and every `msg:` of the socket handlers against
  `en.json`; the old tests compared catalogues with each other and missed this class by
  construction. The Docker handler's messages moved to `msgi18n`, and an unknown key gives a clear
  error instead of its name.
- **2FA showed the backup codes before anything was entered.** The codes are held back until a
  successful verification, and closing the dialog mid-setup says the setup was abandoned. Better
  Auth without `skipVerificationOnEnable` did not turn the second factor on before `verifyTotp`
  anyway, so no one could be locked out, but the interface misled.
- **A migration container counted as a stopped service.** A service is one-shot also when another
  depends on it with `condition: service_completed_successfully`, an unambiguous statement that it
  runs and exits.
- **The folder scan was silent.** It shows progress and reports how many stacks it found.
- **The "New stack" page matches its reference**, agreed on a standalone mockup on the real tokens
  (`docs/design/`, deleted on 2026-09-26) before the code: a 560px card centred in the work area, a
  step track above the source choice, the tabs as a full-width segmented switch, the main action
  filled with the accent, and `docker run` recognition stated plainly.
- **The branch is no longer typed from memory.** `gitListBranches` runs `git ls-remote --heads` on a
  button, not while typing, because it is a network request to someone else's address. The address
  goes through `validateGitRepository`, the call through the guarded `git()` wrapper, and the event
  is operator-only. Until the list is requested the field stays a plain input, so a private
  repository without access does not block the form.
- **One rule for the type scale.** There were 74 uses of 12px against 89 of 14px, with no line
  drawn. 12px stays only where 14px physically does not fit, a number in a badge and initials in a
  circle; the other 95 uses moved to the 14px step, so a hint is no smaller than its field.
- **Settings named for what they hold.** "General" held one setting and read like a neighbour of
  "Dockge Agents"; it is now "Server address". "Shared .env" became "Variables for every stack", with
  an explanation of which `.env` overrides which. The cascade of sections was deliberately left
  alone. About drew the browser tab icon, an opaque green square over the theme; it uses the header's
  outline now. A user's role and access are a pair of badges.
- **MCP keys carry the product prefix** (`dg2_`), and keys issued earlier are still accepted:
  revoking a key is the owner's decision, not a side effect of a rename.

**Left, and why.**

- A ~8px strip on the right: `html { scrollbar-gutter: stable; }` with a transparent scrollbar
  track, a deliberate trade-off against the layout jump when scrolling appears; it needs a live pass,
  not a blind fix. Closed on 2026-09-26: the gutter was removed.
- Interface jitter on restart: needs a live run with a real container.
- A hello-world test container for a full pass: not done.
- Other containers under control. The limit exists because the file editor is locked into
  `DOCKGE_STACKS_DIR`, a path traversal barrier. The ban is excessive, and the proposal is an explicit
  adoption of a stack by `composeStack.ConfigFiles` with a list of allowed paths. Deferred on
  purpose: it needs a thought-out access model, not a checkbox.
- Clarity of the MCP settings as a whole: the key prefix is done, a review of the section's texts is
  not. The MCP settings were reworked on 2026-09-24.

### 2026-09-17: the second spoken report on the live instance - nine items

- **The stack name comes from compose.** `container_name` was read only when converting `docker run`;
  it now also fills the name on a pasted compose, and filling stops at the first keystroke in the
  field, so the person edits instead of fighting. The service name is deliberately not used: it always
  exists, and the stack would name itself. With no named container the field stays empty and the next
  step is blocked, as before and on purpose.
- **The deployment state is not cramped.** While a command runs the create card widens to 820px: in a
  column as wide as an input the services and times read as cut off. The block gained a progress
  header with a pulse, the time and an abort button: `abort()` existed but could not be reached from
  the interface.
- **The "just now" badge became a check mark** with a label for screen readers: the new row is
  highlighted anyway, and the word added nothing and silently went stale.
- **The `.env` field is collapsed by default.** The screen is opened in front of other people, and
  values must not appear on it by themselves. It is revealed by a button, per stack and again after
  navigating away; when a stack is created it is open, since there is nothing to hide. Amended on
  2026-09-24: "Edit" reveals the values at once.
- **The update preview no longer hangs.** Images were checked one after another, each spending up to
  20 seconds in `buildx imagetools inspect` and 20 more in the fallback `manifest inspect`, so a stack
  of six unreachable images looked frozen for minutes. Four images are checked at once and one call
  is limited to 8 seconds. The heading is "Expected changes" instead of "What the update will do",
  the waiting line "Checking the registry" instead of "Check". Replaced on 2026-09-24: the registry
  API is asked directly.
- **Progress and the output window appear faster**, on the shorter motion tokens instead of
  Bootstrap's 300 ms: the window is opened to be read, not to watch it slide in.
- **The service row icon matches its action.** The button drew a terminal and led to the log. The
  terminal now opens a shell and is disabled for a stopped container; the log moved under the three
  dots.
- **bash from the interface.** `docker compose exec <service> <shell>` is `docker exec -it`, and the
  backend accepted `bash` from the start, but the interface always asked for `sh`. Each service has a
  pair of buttons acting as one control, `sh` as the usual choice and `bash` beside it; without bash
  in the image, `assertShellExists` refuses before a session opens.
- **A file manager: not done, and why.** The question was full access to every file of a container.
  A manager outside the container would hit the lock of the file editor into `DOCKGE_STACKS_DIR`, a
  path traversal barrier rather than an interface limit, which must not be lifted for convenience. A
  manager inside would read and write inside a container from the browser, exactly what the rule "no
  events that let the browser run arbitrary commands" forbids. Both need a thought-out access model,
  like the adoption of other stacks, and stand in one row with it.

### 2026-09-18: the dashboard filter turns off, installation becomes one command

- **Dashboard.** A header count ("Needs attention 9") always set its filter again, while the list
  buttons toggled. Pressed again, a count now clears the `filter` in the address, with
  `aria-pressed`. Replaced on 2026-09-26: the counters are links, so the active one says
  `aria-current`. The container table, which arrives late, fades in on `--motion-base`, and not at
  all under `prefers-reduced-motion`. "Waiting for the first Docker observation" lost "Retry": the
  observation comes in its own time and the page rereads every 30 seconds, so the button promised a
  speed-up that does not exist. It stays for an unavailable agent, a failed request, a silent
  Docker and stale data.
- **Installation in one command.** `install.sh` at the root checks the system, Docker and the
  compose plugin, offers the official Docker script, asks for the installation directory, the stacks
  directory and a free port, writes `.env`, builds, starts with `--wait`, and prints the address and
  the setup code, read inside the container because the host file is `0600` and owned by root.
  `--update` reuses the answers in `.env` and only rebuilds. Sudo only where needed; other people's
  containers are only counted and left alone.
- **The host no longer needs Node.** A `build_frontend` stage builds the frontend inside the image;
  `.dockerignore` excludes `frontend-dist`, so a local build cannot replace it. In
  `update-dockge.ts` an update is `git pull --ff-only`, a configuration check and a rebuild, without
  `npm ci` or a frontend build.
- Replaced since: on 2026-09-19 `install.sh` downloads the published image and builds only when
  there is none, and from 0.0.9 installs and updates verify a signed release and pull its image by
  digest; `update-dockge.ts` was removed in 0.0.9 (see `docs/self-updates.md`).
- **Languages.** Only the fully translated English and Russian stay in the switcher: the other nine
  catalogues had 111 to 130 of 777 keys, and a half-English panel is a breakage, not a choice of
  language. The files stay in `lang/`, and the `i18n-catalogue` test requires every complete
  catalogue in the menu and no incomplete one, so a finished translation comes back by itself.

### 2026-09-18: a stack that builds its own image is rebuilt

The Dockge 1 complaint that edits did not apply without `up --build` held here too:
`compose up -d --remove-orphans` in `Stack.control` reused the existing image after a Dockerfile
edit. `hasBuildServices` in `common/compose-status.ts` tells whether a stack declares any `build`.
Such a stack is deployed and started with `--build`; an update runs `pull` (which skips built
services), then `build --pull` - the only way to refresh the Dockerfile's base image - then `up -d`.
Stacks of registry images do not build. The update preview, which showed an empty image list with
no reason, now says the images are built from a Dockerfile and will be rebuilt.

### 2026-09-18: the image had no git, so Git stacks did not work in production

The production image had neither `git` nor `ssh`, so clone, `behind`, comparison and applying an
update all failed in a built panel; the development container lacked `git` too, but never called
those paths. `git` and `openssh-client` went into `docker/Base.Dockerfile` and also into the
`release` stage of `docker/Dockerfile`, because the base image is published by hand and rarely.
Replaced on 2026-09-19: `docker/Dockerfile` builds everything itself from the official `node` and
`golang` images, and `docker/Base.Dockerfile` is gone, so a fresh install depends on no image
someone had to push.

The panel runs git with `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_GLOBAL=/dev/null`, an empty
`credential.helper`, `core.sshCommand=ssh -oBatchMode=yes` and only `http/https/ssh`, and
`validateGitRepository` rejects a token in the address (`backend/stack-git.ts`). A private
repository therefore needs an SSH key without a passphrase mounted into the container, plus
`known_hosts`; `docker-compose.yml` got a commented-out `/root/.ssh:/root/.ssh:ro` and the README a
section. `gh` is not needed: the panel talks to Git, not to the GitHub API.

### 2026-09-18: the installer, no branch without a way out

`install.sh` reviewed for where it gets stuck, lies, or allows no way back:

- A repeat `--port` printed a new address but left `.env` alone. A named parameter now rewrites its
  `.env` line, the final address comes from `compose ps`, and moving the stacks or data directory
  warns that old files do not follow.
- `--update` put a second copy in `/opt/dockge2` and always used `main`. It now takes the directory
  from the script's location and the branch from the checkout. A `trap` after an interrupted
  `git clone` removes only what the script created.
- Under `curl | bash` every `confirm` silently said "yes" (`[ ! -t 0 ]` looked at stdin, the
  questions read `/dev/tty`), including installing Docker and rebuilding a running panel. Without a
  terminal the script now stops and asks for `--yes`.
- With a root-owned directory and docker without sudo, `docker compose` could not read the `0600`
  `.env` and silently used the defaults. The file now belongs to whoever runs docker, and
  `compose config --quiet` runs before the build.
- The answers are shown as a list to confirm, change by number or leave with `q` before anything
  changes; a bad port or relative path is asked again, a busy port suggests a free one. The
  directories of a running installation cannot be changed from the menu, and it says why.
- Failures are named: disk space, a registry refusal, the container state and its last log lines.
  The running image is tagged `dockge2:rollback-<date>` before a rebuild, and a failure prints the
  commands back to the previous commit and image. Local edits are never reset or stashed: an update
  is fast-forward only and otherwise touches nothing.
- An old Compose without `--wait-timeout` (since 2.17) is not taken for a sick container, disk space
  is checked first, `firewalld` joins `ufw` with a reminder about cloud firewalls, and Podman is
  recognised but marked as untested.

### 2026-09-19: the installer, a second pass with every claim reproduced

Every remark was reproduced on `docker` and `sudo` stubs before it went into the plan; all six held.

- `--update` by a `docker` group member over a root-owned `0600` `.env` failed with a bare `awk`
  error, and an unreadable `.env` counted as empty, so sudo created `/opt/stacks` and
  `<install>/data` that nobody chose. The file is read with `sudo cat` and its owner fixed before
  any edit.
- In update mode item 3 of the menu pointed `DOCKGE_DATA_DIR` at a new empty directory, so the panel
  came up with an empty database. It is closed like items 1 and 2.
- After `git checkout <commit>`, `--update` claimed "Now at X on main". A detached HEAD now stops
  with the command back to a branch.
- Only the previous `dockge2:rollback-<date>` image is kept (each is several hundred MB); only the
  installer's own tags are removed, and only after a successful start.
- A pre-created empty directory is emptied, not deleted, after a failed clone. The firewall check
  matches the port as a word (500 matched 5001). `update-dockge.ts` waits 180 seconds, not 60, as
  the installer does: the healthcheck starts after 60 seconds and repeats every 60.
- `test/install/run.sh` (`npm run test:install`, in CI) runs these and the previous day's cases on
  stubs and a local two-commit origin, the menu through `script(1)`; shellcheck at the style level
  is clean.

### 2026-09-19: Git and Docker, one state, one check, one git call

- `common/stack-source.ts` names a directory `local`, `unreadable`, `edited`, `behind`,
  `editedBehind`, `clean` or `unchecked`; the list row, the source panel and the inspector all use
  it instead of three conditions of their own.
- A zero `behind` after a clone means origin was never asked. The age of the check is the time of
  `FETCH_HEAD`, written only by `fetch`; without it the panel says "The remote repository has not
  been checked yet". The only possible error understates freshness, the right side to err on.
- Dead parts removed: the unread `source` field of `GitUpdatePreview` and `GitSaveResult`, a list
  row line under an unreachable `v-else`, fourteen unreferenced strings.
- One place each: `backend/git-command.ts` is the only launch of git (inherited `GIT_*` cleared,
  prompts and system configs off, transports allow-listed, hooks and submodules off);
  `backend/compose-args.ts` the only builder of `docker compose` arguments, once written twice with
  different strictness about `global.env`; `common/git-repository.ts` the only address rule, since
  the browser enabled the button for addresses the server rejected.
- `test/e2e/git-stack.spec.ts` covers the cycle against a fixture repository served over HTTP,
  because the server does not and must not accept a local path as a remote: create, branches,
  "Files match" without new commits, a per-file comparison of a new commit with the env file hidden
  as a possible carrier of secrets, compose from Git with env kept, then "Edited on the server". It
  starts no containers. It was not run that day: a working local instance held ports 5000 and 5001,
  and `reuseExistingServer` would have used its directories.

### 2026-09-11: Sites and MCP conformance

Status on 2026-09-13: implemented on 11 September, visual acceptance reopened; the checks of that
day do not confirm that the visual polish is finished.

- Done: visual acceptance A6 and polish R0-R6 of the Sites audit (deleted 2026-09-26). Replaced:
  acceptance runs on `test/visual/baseline/`, the passes of 2026-09-15 and the consolidated "New
  stack" page; the last two criteria went to "Interface and Docker overview: open tasks", item 5,
  done in 0.0.14.
- Done: M0-M7 of the MCP and keys plan (contract in `docs/mcp.md`): own AI agents, revocable keys,
  roles and server and stack limits, a log and a check on every call. A viewer gets no write action,
  directly or through an executing server.
- Kept: closed issuance of accounts, themes, uptime, docker run conversion, the Compose source text,
  and saving distinct from deploying.
- M7 covered SDK 1.30.0, protocol 2025-11-25 and Bearer only; OAuth, stdio and particular desktop
  clients are not implemented, and the signed cross-server channel does not replace the browser
  channel of agents. Replaced on 2026-09-24: protocol 2026-07-28 through
  `@modelcontextprotocol/server` 2.1.0, with 2025-11-25 clients still served.

### 2026-09-20: fixes from the second review before 0.0.6

All remarks of the second review (deleted 2026-09-26) were done: Q01-Q05, UI01-UI03, L01-L08,
E01-E20.

- An operation owns its boundary: the stack lock is held from reading the choice to the write, a
  stop reaches the running round and its request, and the stop budget no longer hands out shares
  larger than itself.
- Permission for the update notification is read in one place on the server, so turning it off
  hides the news everywhere at once.
- The complexity limit is mandatory (`complexity: [ "error", 20 ]`).
- An open menu picks its side by free space and scrolls inside itself; editors have accessible
  names; a muted state is muted by colour saturation, not by the opacity of the whole link.
- Both catalogues were fixed, since some defects were in the English source; gender in the progress
  line uses forms per resource type, filter hints are standalone messages.
- Not done then: MCP refusal reasons by code. Closed on 2026-09-26: `/api/mcp` answers
  `mcpOriginDenied` or `mcpOwnerRequired`. Docker integration, E2E and the image publication were
  not run that day.

### 2026-09-21: three items closed after an independent check

Three items declared complete were partial: cancellation did not reach the container statistics
collector (Q02), a stop during a settings read did not stop a new request to the release registry
(Q03), and the editors' accessible name appeared only on a later re-render (UI02). The lifecycle
state is now read again after every wait, not only before it, and a name belongs to the component,
not to whoever re-renders it: the CodeMirror configuration sets it from the first render and follows
a change of file. The stop signal reaches the sweep write and the stability collector with a check
before every database call; inside a transaction it rolls the write back and is not reported as a
Docker failure. Cancellation stops at the nearest check, not instantly: the round drops its work on
the signal, and whoever owns the resources waits for it within the budget. A new test requires that
saved settings reach every open session: breaking that broadcast used to fail no test. Each new
check was shown to fail on a mutation of the working code.

### 2026-09-21: removing leftovers, and a hole in the build context closed

`docker-compose.yml` suggests `./certs` in the installation directory for the `DOCKGE_SSL_*` files,
the release stage copies the whole context, and `.dockerignore` did not exclude `certs`: an image
the installer builds itself would carry the HTTPS private key, as a build with a planted key showed.
`certs`, `docker-compose.override.yml` and `.claude` are excluded now; they belong to whoever
deployed the panel. `.dockerignore` is wider than `.gitignore` and says so; `output/`, the
directory of acceptance artefacts, is ignored by Git.

Dead code and forty-seven unreferenced translation keys were removed, and twenty-three symbols used
only in their own file lost `export`: an export nobody uses reads as an invitation to use it. A text
search first found fifty keys: it misses keys assembled in code, such as
`` $t(`availabilityWindow${hours}`) ``, and the stability period selector showed a key name instead
of "24 h" until the visual suite caught it. Dead keys are now counted with every dynamic prefix.
`build:docker` no longer tags `ghcr.io/mazixs/dockge2:2`, an upstream leftover the fork does not
have.

### 2026-09-21: history rewritten

A scan of every history object found the working-copy path in four old plans and the owner's
personal domain in seven files of `docs/design/`, long gone from HEAD. The history was rewritten
with `git filter-repo --replace-text` in a separate mirror clone, both replaced by neutral
placeholders; the HEAD tree, all 494 commits, their messages and authorship are unchanged. The
author's email stayed at the owner's decision; contact details are not given in the documentation.
`main` and five tags were force-pushed after a backup; the GitHub releases stayed. Old commits stay
reachable on GitHub by direct SHA until its garbage collection; only a request to GitHub support
can speed that up.

### 2026-09-21: release 0.0.6

The `v0.0.6` tag published the image for `linux/amd64` and `linux/arm64` to `ghcr.io/mazixs/dockge2`
as `0.0.6` and `latest`, with an automatic GitHub release. On the tag two browser tests failed on
stale English wording, not on behaviour. `npm run check` runs neither `test:e2e` nor the Docker
integration, so it does not see a change of interface text: run `npm run test:e2e` before a tag.

### 2026-09-21: container controls and interface fixes

- Restart recreates containers using the current Compose and env files; service restart leaves dependencies alone.
- The service menu dismisses on outside pointer interaction and Escape, and offers an image update for that service.
- File editor selection is visible in both themes. Settings categories switch without an entrance animation.
- Managed container names in the global overview link to their stack inspector, preserving the agent endpoint.


### 2026-09-21: update settings

- Separate automatic update checks, beta-release inclusion, an explicit manual check, and a quiet repository link.
- A manual check works with automatic checks disabled and does not change that preference.
- Report fresh success or failure, prevent duplicate in-flight requests, and broadcast successful scheduled checks to connected browsers.


### 2026-09-21: deletion of broken stacks

- Deletion no longer requires fixing YAML, project names or missing env files first.
- When Compose validation fails, recover containers using their recorded working-directory labels and immutable IDs, including stopped containers. Never infer ownership from a project name alone.
- Recovery stops and removes containers without deleting Docker volumes. It leaves networks because their labels do not prove directory ownership. The stack directory is removed as stated in the existing confirmation.
- A failed Docker query, stop or removal keeps the stack files. Deletion uses the shared operation progress and preserves failed/unknown outcomes on the current screen.


### 2026-09-24: sign-in language and locked editors

- The sign-in screen offers the language next to the theme. English is the default: the browser language is ignored, and a first run, cleared storage or a stored code the menu no longer offers opens in English. The menu lists English, then Russian, then the rest by name, independent of the browser collation.
- A stack's compose and env editors outside edit mode took paste, drop and cut: `vue-codemirror6` maps `disabled` to `EditorView.editable` only, while CodeMirror gates those events on `EditorState.readOnly`. The text stayed in memory, survived "Edit" and was saved with the next edit. Both editors now pass `readonly` as well.
- A compose file pasted into a locked editor also opened "new stack". The global paste handler now ignores a paste that an editor has already cancelled.
- `test/visual/editor-lock.spec.ts` covers paste, cut, drop and the unchanged address on the real `Compose.vue`, and that an unlocked editor still takes a paste.


### 2026-09-24: MCP on the current protocol, easy to connect, fully logged

Measured against the MCP best practices checklist (the latest specification, SDK v2, Supabase MCP and our own tool-design research; deleted 2026-09-26, its refusals moved to `docs/mcp.md`).

- The endpoint serves protocol 2026-07-28 through `@modelcontextprotocol/server` 2.1.0 (`createMcpHandler`, stateless, `server/discover`, the per-request `_meta` envelope). 2025-11-25 clients keep working through the SDK's stateless legacy path. POST only; OAuth discovery paths answer 404 JSON; a 401 carries `WWW-Authenticate: Bearer`.
- Tools are listed in a fixed order with titles, honest hints, field descriptions and server instructions describing the flow and naming logs, files and diffs as untrusted. Argument errors name the field; conditions a client can fix say how; access and existence stay one generic sentence.
- Settings: a status panel (state, endpoint, encryption, active keys, last connection, last refusal with its reason); the URL prefilled from the page or `DOCKGE_PUBLIC_URL`, a warning when its host differs from the page, plain HTTP beyond loopback only after an explicit opt-in; success and every failure named in words. "Connect a client" gives configurations for Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI and a `curl` check, all reading the key from `DOCKGE_MCP_KEY`.
- "Reserve a name for Git" was unexplained. It reserves a future stack name so an operator key can `git_clone` into it; nothing is created on disk. The panel now explains it, lists reservations with the keys they are granted to, removes an unused one and reports a duplicate.
- The access log did not record connections or refusals. It now records `initialize`, `server/discover` and `tools/list` with client name, version and protocol; refusals with reason and address; requests the SDK rejects before a tool runs; owner actions including operation approval. Repeats are counted per source and minute, refusals are capped separately (1000 rows) from history (10000 rows), and arguments, secrets and results are never stored.
- A startup crash found by the browser suite: `mountMcp` opened the database before it was connected. Keys are now looked up per request; a unit test mounts the routes without a database.
- `docs/mcp.md` rewritten in English: quick start, client configurations, tools, rights, approval, reserved names, security including prompt injection through logs, reaching the endpoint (proxy, opt-in HTTP, SSH tunnel), troubleshooting by status code, the log, executing servers, limits, verification.
- Not done, with reasons in `docs/mcp.md` ("Not implemented, and why"): OAuth 2.1, elicitation instead of owner approval, Server Cards, random boundaries around untrusted output.

### 2026-09-24: env on edit, image update check without buildx

- "Edit" reveals the env values at once: a hidden value cannot be edited, and the second click on "Show" only got in the way. "Show" outside edit mode still reveals them read-only.
- The update preview said "the registry did not answer" for every multi platform image in the published panel: the image has no buildx, and `docker manifest inspect` rebuilds an index instead of returning it, so its digest never matched. The registry API is now asked directly (one HEAD with every manifest type accepted, an anonymous token or the plain `docker login` entry, credentials only to an HTTPS realm); its digests match `buildx imagetools` byte for byte on ghcr.io and Docker Hub.
- An unknown answer names its cause: refused access (private image or wrong name), no such tag, or no answer. A failed answer is kept for one minute instead of ten.

### 2026-09-24: the owner turns the console on, role audit

- Reverses the decision "do not add a switch in the interface" (see "The panel's own container and the main console"), at the owner's request. An owner turns the console on in Settings, Security, confirming with the password; turning it off needs no password and ends the open sessions. `DOCKGE_ENABLE_CONSOLE=true` still forces it on, and the setting then cannot turn it off. "false" cannot be a lock: the frozen `docker-compose.yml` always passes it.
- No new privilege: an owner already reaches the host through compose (privileged services, host mounts).
- One gate: `MainTerminal.state()` (variable or setting) and `MainTerminal.open()`, the only way to create the session. Each server decides for itself; an agent's console is turned on in the agent's own panel.
- Role audit, by weight, with what was done the same day:
  - Fixed: the console and container shells were shared sessions (one `console` terminal for everyone; `interactiveTerminal` always used index 0, so a second user joined the first user's live shell). Every private session is now filed under its owner: `TerminalOwner` = account plus, for a panel that connects as an agent, the `x-dockge-terminal-client` header (a sha256 of the panel user's id), because every user of a panel signs in to the agent with one account. The header only divides one account's sessions, so forging it reaches nobody else. `Terminal.forClient()` returns the client's own session or shared output, never another user's session, whatever name is sent.
  - Fixed: `terminalJoin` returned the scrollback of any terminal by name. It goes through `forClient()` now, as do input, leave and resize.
  - Fixed: demoting, suspending, resetting or deleting an account now also ends its shells (`Terminal.endOwnedBy`), not only its connections.
  - Fixed: user management (create, reset password, role, delete) asks the acting owner for their password; a wrong one is not masked as "account exists".
  - Added: who opens the console, `consoleOperators`, owners only by default. Checked in `authorizeSocketEvent` for `mainTerminal` / `checkMainTerminal`, so it holds for local and proxied calls; letting operators in takes the password, narrowing ends the console sessions of everyone who is not an active owner. This narrows existing installations with `DOCKGE_ENABLE_CONSOLE=true`, where operators could open the console before.
  - Open: an owner has no per-user restriction beyond the three roles: no per-stack or per-agent scope for browser users (MCP keys have it), no 2FA reset or requirement, no session list, no audit log outside MCP.
  - Open: across agents every local user acts as the one stored agent account: remote secrets check that account's password, and the lockout counter is shared. Shells are separated by the header above, but the agent's own role and console setting apply to the agent account.
  - Open, by design: an operator deploys arbitrary compose, which reaches the host (privileged services, host mounts); keeping the console to owners does not change that.

### 2026-09-24: `DOCKGE_ENABLE_CONSOLE` is no longer read

- Follows the entry above, at the user's request: the setting is the only switch. The variable forced the console on and hid the toggle, so an owner could not take the console back without editing `.env` and restarting.
- No migration: an installation that ran with `DOCKGE_ENABLE_CONSOLE=true` comes up with the console off until an owner turns it on. The `--enableConsole` flag and the "forced" state of `checkMainTerminal` are gone; the gate is `MainTerminal.enabled()`.
- The frozen `docker-compose.yml` still passes the variable and the updater still writes `DOCKGE_ENABLE_CONSOLE=false` into a new `.env`; both are harmless now.

### 2026-09-25: updating the panel from the web interface

- Reverses "do not add a Socket.IO event that starts an update from the browser"
  (Task 6, step 2 of the upstream fixes plan, deleted 2026-09-26) at the user's request. That rule was written for
  `git pull` plus `docker compose`. The verified updater takes a version and installs only a release
  signed by the release workflow, and an owner already reaches the host through compose.
- Decomposition: `docs/panel-update-statechart.md` (invariants, updater contract, observer,
  page statechart, scenarios; moved out of `docs/plans/` once implemented), reviewed independently
  before implementation. Shared contract:
  `common/panel-update.ts`.
- The panel never runs `docker compose up` on itself. It starts a one-shot helper container from its
  own image (docker CLI and compose plugin inside) that runs the installed `<dir>/.dockge2/update`.
  The helper is outside the Compose project, `--restart no`, not removed on exit, with fixed names per
  kind (`dockge2-update-<project>-preview|apply|status`) so a second one is refused atomically, and
  the `json-file` log driver so its output survives. The updater keeps doing the whole cutover.
- The installation directory comes from the `com.docker.compose.project.working_dir` label of the
  panel's own container. The helper mounts it and the data directory read-only, `.dockge2`, host
  `/tmp` (lock and staging) and the Docker socket writable, at identical paths. `otherWriters` skips
  read-only binds, so the updater needs no self-exclusion and the helper cannot damage the data. The
  frozen `docker-compose.yml` does not change.
- Updater changes: `--progress json` (a line per phase, recovery phases included, a preview line on a
  dry run, a journal line with `--status`, exactly one result line on every exit path, `no-change` as
  its own outcome); `--restore-on-failed-start`, which restores the verified stopped-data snapshot when
  the target never became ready and the schema changed, in a nested container so the helper stays
  read-only on the data - the schema hash covers `package-lock.json`, so without it a rollback would
  almost never be automatic; a persistent Cosign trust root under `.dockge2`.
- The server keeps no update state in memory: it is the thing being replaced. The truth is the helper
  container (labels: request id, kind, from, to, start) and its JSON lines, derived fail closed. A
  helper that left no result line is resolved by a `status` helper reading the journal. Cancel is
  SIGTERM and only before `downloaded`; a running helper is never stopped or removed.
- The page runs the statechart from the root of the application (the About screen unmounts on
  `needAuth`), with a Progress region (`Submitting`, `Preparing`, `Cancelling`, `Cutover`,
  `Verifying`) and a Link region (`Online`, `NeedAuth`, `Offline.Waiting`, `Offline.Overdue`). While
  running it suppresses the connection-lost banner, the reloads on `info.version` and `refresh`, and
  preload-error reloads, and keeps the operation in `sessionStorage`. "Updated" needs the updater's
  `success` for this request and the answering panel on the target version - both, never either.
- Events: `panelUpdateStatus` for every signed-in user (owners also get the path and errors);
  `panelUpdatePreview`, `panelUpdateApply` (password, and a fresh preview of the same version),
  `panelUpdateCancel`, `panelUpdateDismiss` for owners. None is an agent event, in the operator or
  agent allowlists, or an MCP tool, and a test keeps it so.
- Tests: the reducer by table and by a model check (every sequence of five events, sampled sequences
  of seven: the full search to seven does not fit in memory); the contract parser and derivation;
  the observer with an injected Docker runner; the updater in Go; Docker integration with a fake
  launcher; in the release gate a dry run and a same-version run through the helper. The first real
  cutover from the page is 0.0.14 -> 0.0.15 on the review VPS; reaching 0.0.14 still takes one update
  from the host.
- The hint on Settings -> About is fixed with it: the command was relative, had no sudo or
  `--dry-run`, and sent legacy installations to the README although the guide is `docs/updating.md`.

### 2026-09-26: review of the panel self-update

An independent review (`docs/plans/2026-09-26-hfsm-update-review.md`, deleted once closed)
reproduced four defects; all four are fixed before 0.0.14 with a regression test each, and each
test fails without its fix.

- R1 (blocked the release): `--resume` after an automatic restore ran the target again over the
  restored data, and a later rollback skipped the copy because the restore markers belong to the
  operation id. `--resume` now refuses once `RestoreData` is recorded or the failed-data directory of
  the operation exists; `--rollback --restore-data` finishes it.
- R2: a timed-out `docker run --rm` only killed the client; the restore container went on writing.
  The updater removes it by name on a deadline of its own; when it cannot confirm that, the journal
  stays `rolling-back` instead of `recovery-required`. A Go test against the real daemon, opt-in with
  `DOCKGE_DOCKER_INTEGRATION=1`, repeats the reviewer's probe.
- R3: the journal line did not carry `restoredData`, and the page read the missing value as "data not
  touched". The line carries it for `recovered`; without it the page says nothing about the data.
- R4: `Preview.Checking` had no deadline. It now asks for the status after a minute online without
  news and shows that the check takes longer; the model check asserts I2 for it.
- Not done here, as the review suggests: a real version change through the helper with a failed
  target after its migration, on a separate environment - still the first cutover of 0.0.15.

### 2026-09-26: documentation cleanup

- Deleted from the tree: 22 finished plans, audits and reviews in `docs/plans/` and all of
  `docs/design/` (7 files, a 213 KB mockup among them). Their open items are now the backlog sections
  "Interface and Docker overview: open tasks", "Operational acceptance" and "Technical debt from
  reviews and audits"; the checklist no longer points into deleted files. The header says how to
  read one from history.
- Rules moved to where they are read: MCP refusals to `docs/mcp.md`; the cache contract, rejected
  experiments and coverage floors to `docs/development.md`; dependency rules to
  `.github/CONTRIBUTING.md`; one-shot marking to `docs/faq.md`; editing rules to
  `frontend/src/lang/README.md`; muted states by saturation to `docs/design-system.md`.
- Stale statements corrected: the checklist status of the product tasks, `rtlLangs`, and the end of
  `docs/self-updates.md`, which still said the release workflow had never passed.
- Left in the tree: this journal and the decomposition of unfinished work. The plan of the panel
  self-update and its review fold in here once 0.0.14 ships.
- The frozen design export removed on 2026-09-16 comes back with
  `git checkout 0983aff^ -- docs/design/reference`; `39f78b2`, named in its old pointer, is
  unreachable after the history rewrite.
- Privacy pass over `docs/`: no names, contacts, hosts, local paths or keys; the screenshots show
  invented data only. The 2026-09-22 privacy review found one gitleaks match in history, the RFC 6238
  test vector of a removed TOTP test, which is not a secret.

### 2026-09-26: list, containers outside the stacks, the panel's own stack

Items 1, 2, 3 and 6 of "Interface and Docker overview: open tasks", shipped in 0.0.14.

- The list searches the image of each service and the server name as well. The search text lives in
  `?q=` next to `?filter=`, and every link inside the list keeps both, so a narrowed list survives
  opening a stack and a reload. The rules are in `frontend/src/stack-list-model.ts`, tested without
  a browser.
- Each server group shows 50 rows and a "Show N more" button after them; the open row is shown even
  past the limit. Not prev/next pages: a list is scanned from the top, and a page number means
  nothing in it. No virtualisation: with 50-row pages the 2026-09-22 measurement at 500 containers
  gave a p95 of 108.9 ms against 510.8 ms for the full render, under the 200 ms threshold, and the
  model filters and sorts 500 rows in under 16 ms.
- Relations are read only, in the stack inspector. A stack of this panel is read from
  `docker compose config --format json` of its own files, so stopped services and override files
  count; a project the panel does not manage, from `docker inspect` of its containers: the
  `depends_on` label, networks, ports, mounts, secrets as mounts under `/run/secrets`. The
  environment never leaves the server, and a Compose error is logged as a fact only, because it can
  quote interpolated values. `stackRelations` is an operator event, since viewers have no access to
  files. Each running container links to its page.
- Mass start/stop/restart is not done: it needs the user's agreement, with a preview and a result per
  stack. It stays in item 1.
- A container's source comes from its labels only (`backend/container-source.ts`): managed when the
  recorded working directory lies directly in the stacks directory, external-compose, standalone
  without any Compose label, unknown with partial labels. Standalone rows come from the `docker ps`
  the status tick already runs. `StandaloneInventory` keeps them between readings, so a Docker that
  stops answering turns them unknown with their last-seen time instead of hiding them. `docker
  inspect` runs only when a container page opens.
- External projects are always shown, without an `all-readonly` switch: seeing them adds no
  capability (no actions, no files, no environment), and hiding them made the host look emptier than
  it is. The switch is not planned.
- `all-control` is the owner setting `containerControl`, per server, off by default, turned on with
  the password. It lets operators start, stop and restart external-compose and standalone
  containers. The server inspects the container again right before the command and refuses managed
  containers (they go through their stack), unknown ones and the panel's own. Delete, kill and exec
  wait for their own access model. An older agent sends no standalone rows, so neither the group nor
  the buttons appear for it.
- The panel identifies its own container by the id in `/proc/self/mountinfo` and the working
  directory label, never by name. When its compose file lies in the stacks directory it is a stack of
  the list, but the server refuses down, delete, start, restart, deploy and update on it with
  `stackIsPanel`, because all of them recreate or remove the container that runs the command. Stop
  stays, with a warning that the page goes away with it. Settings -> About has a read-only card:
  image and digest, health, uptime, restarts, mounts, the Docker socket with its risk; anything Docker
  does not report is unknown. Tests cover both placements.
- Agent rename is a button in the agent row over the existing `updateAgent`.
- Tests: unit tests for the list model, relations, container source and the panel's own container;
  Docker integration with a project in a temporary directory outside the stacks directory; e2e for
  search in the address, the attention filter by link, the keyboard, the phone, relations leading to
  a container page, and a standalone container stopped and started once the owner allows it.

### 2026-09-26: docker run converter of our own

Item 4 of "Interface and Docker overview: open tasks", shipped in 0.0.14.

- The corpus came first, as planned: `test/fixtures/docker-run/`, each fixture stating what must
  survive, what is reported and what must not be added. On the 39 initial fixtures `composerize`
  kept 19, warned on 6 and lost 14, and Compose rejected 5 of its files. That decided the question:
  `composerize` is replaced by `common/docker-run-compose.ts`.
- The converter knows every flag of `docker run --help`, about a hundred. Each one is either written
  to the file or named in the report with its reason (carried, review, dropped); the report no
  longer guesses from the output of somebody else's converter. It adds no `version`, no default
  network, no `privileged` without `--privileged` and no `container_name` without `--name`. It writes
  YAML 1.1 without line wrapping, so `no`, `yes`, `22:22` and `0755` stay quoted strings.
- Result on the same 39 fixtures: kept 26, warned 10, lost 3, invalid 0, and no fixture got worse. 12
  more were added: 51 in total, kept 32, warned 11, lost 8, every output accepted by
  `docker compose config` in a temporary directory without starting anything.
- Still not carried, on purpose: `-P` (nothing in Compose matches it), unknown flags, flags without a
  Compose key (`--cidfile`, `--umask`, `--kernel-memory`), and rare ones whose Compose form differs in
  meaning (`--link`, `--blkio-*`, `--device-*-bps/iops` and a few others). All of them are named in
  the report. `docker run --unknown nginx echo hi` stays ambiguous: without knowing the flag it
  cannot tell its value from the image.
- Named volumes and networks are still written as `external: true`, as before, and the report says
  they must exist. Writing `name:` would let Compose create them the way `docker run` does, but it
  changes what an existing workflow gets; not done without a reason from a user.
- The dependency is gone: 11 packages and about 10.4 MB, 7.7 MB of it `core-js@2`, and
  `composeverter` had been pinned as `latest`, that is not at all. With 7 packages that became
  development only, the production install is about 13.4 MB lighter.
- The event is renamed from `composerize` to `convertDockerRun`, the sheet waits for it 15 seconds,
  and it recognises `docker container run` as the server does. The input limit of the event stays.

### 2026-09-26: technical debt from the reviews and audits, closed for 0.0.14

Every item of "Technical debt from reviews and audits". Where an item was decided rather than built, the reason
is here, so it is not reopened without a new one.

- **Ack deadlines.** Every request the interface waits on goes through `emitAgentRequest` with a
  deadline; only `terminalLeave` and `terminalResize` stay fire-and-forget. A deploy or update whose
  answer is lost rereads the stack state instead of repeating the command.
- **Refusal reasons.** `/api/mcp` answers `mcpOriginDenied` or `mcpOwnerRequired`, and the MCP
  settings name the action. The Git flow writes why `compose config` or a deploy refused into the
  server log, shortened and with credentials cut out; the client keeps the former keys.
- **Reading files.** `composeYAML` and `composeENV` are read by an asynchronous `loadTexts()`
  snapshot. Global state (`Settings.cacheList`, `Terminal.terminalMap`, `Database`) moves to the
  server instance only together with a change of the scenario that uses it; not a task of its own.
- **Frontend coverage.** `frontend/src/mixins` is inside `.c8rc.json`, and the "Interface state"
  group of `extra/check-coverage.ts` holds 90%. Components are tested through
  `test/helpers/sfc.ts`, which runs the options of a component against a context the test controls;
  rendering is left to Playwright. No component test library: logic that needs testing moves into a
  `.ts` module c8 counts. `extra/check-bundle.ts` writes KiB and holds each lazy chunk to 480 KiB,
  160 KiB gzipped.
- **Security headers.** `backend/security-headers.ts`: CSP with scripts from the panel only,
  `nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `Referrer-Policy`, COOP. Styles keep
  `'unsafe-inline'`, because xterm writes `<style>` elements without a nonce, so the
  `EditorView.cspNonce` spike is not needed. `docs/threat-model.md` explains why the socket is root
  and `:ro` does not limit it, and lists every path to it, containers outside the stacks and the
  panel's own container included.
- **Supply.** `.npmrc` sets `min-release-age=7` (npm 11.10 and later obey it), npm is in Dependabot
  with cooldowns, CI runs shellcheck on `install.sh` from a pinned image, and the visual suite runs
  in CI inside the image the references are approved in.
- **Majors, one at a time.** TypeScript 6.0.3 (exact; 7 does not start `vue-tsc`, which stays on
  2.2.12, since 3.x reports two false errors in `Compose.vue`). vue-router 5.3.1: route guards
  return a boolean instead of calling `next`. Express 5.2.1 with `express-static-gzip` 3.0.2: wildcard
  routes are named (`/*splat`, `/{*splat}`), the MCP SDK's own Express 5 is now deduplicated with
  ours. `@types/node` follows the Node of the image, 24.
- **tsx against native type stripping.** Not in 0.0.14. Counted: about 780 relative imports without
  an extension, 13 classes with parameter properties, 29 type imports used as values, JSON imports
  without `with`. The order, when it is done: `erasableSyntaxOnly` and `verbatimModuleSyntax`
  first, then the extensions, then the switch of `node --import tsx` in the image.
- **Test bench.** `test/e2e/teardown.ts` stops `e2e-files` by project name, whatever compose file
  a spec chose; the progress spec has a stack of its own and passes alone. A rootless Docker daemon is
  not introduced: containers are chosen by exact name and project label, the 500/2000 measurements
  run on the synthetic `DOCKGE_PERF_*` fixture, and CI runners are clean.
- **`docker events`.** Polling stays at 10 s: the tick costs 85-155 ms. Revisit when a tick grows
  past about a second.
- **Small items.** `"mysql"` and `Database.getSize()`/`shrink()` are gone. 87 catalogue keys renamed
  to camelCase and 13 unused ones removed; `frontend/src/server-message-keys.ts` maps the keys an
  older agent or the original Dockge still sends (`Saved`, `Deployed`, ...), and
  `test/frontend/i18n-catalogue.test.ts` holds both the naming and that map. `toastSuccess` and
  `toastError` take a key and translate it themselves: a text translated before the call was
  looked up again and shown as an unexpected error. `Cmd+V`: the e2e test passes on Linux without
  the `metaKey` branch too, so it proves that Meta+V types no stray `v`, not the macOS paste itself;
  an honest limit. A MCP key is reissued with an overlap: the new secret keeps the servers, stacks,
  mode and lifetime, the old one works 24 hours more or until its own expiry, the same role and
  scope checks apply, and the audit records `key_reissue`.
- **Found on the way.** The ten second round reused the cached list of managed stacks and kept a
  stack running after its project left Docker, until something dropped the cache; fixed in
  `Stack.getStackList`, test in `test/backend/stack-list-cache.test.ts`. A race between
  `bindTerminal` and the first output is fixed through `onAnswer`.
- **Strict TypeScript in components.** Every component with a script is `lang="ts"` and passes
  `vue-tsc` with `strictTemplates`; `test/frontend/sfc-type-check.test.ts` keeps a new one from
  coming back as JavaScript. `Container.vue` now reads its compose page through one typed accessor
  that fails loudly outside that page instead of reading `undefined`.

### 2026-09-26: the final UX, accessibility and performance check

- **2000 containers, 300 stacks.** `npm run test:performance` on the synthetic fixture, a
  production build, CPU throttled four times. The filter's p95 is 137.1 ms over 5 cycles and
  124.7 ms over 40, under the 200 ms bar. Over 32 seconds of snapshots `snapshotChurn` saw no node
  added or removed in the list or the overview; the 2426 attribute changes in the overview are the
  `title` of the 48 history buckets, whose window follows the clock, and cause no long task. DOM
  nodes (9741) and event listeners (386) stay flat after warm-up at 5, 20 and 40 cycles, the heap
  holds 24.5-26.2 MiB, no page error, pagination works from the keyboard. The fixture now goes up
  to 5000 containers; stacks and cycles stay capped at 1000.
- **The state matrix.** `test/visual/state-matrix.spec.ts` checks each state by its words rather
  than a screenshot: loading, empty, stale, Docker unavailable (a retry, and the list says unknown
  rather than stopped), attention, no history, a viewer's read-only stack page. Layout: the first
  five of hundreds of stacks fit 1440x1000, the heading and first field of the create form fit
  390x844, a long name is shortened with its full text in a title, and at 200% (720x500) neither
  the list nor a stack page scrolls sideways. `?matrix=` of the scene changes only what the fixture
  answers.
- **Lighthouse accessibility** is 100 on the dashboard, a stack, its files, the create form, About
  and Security. Two findings were fixed: the overview's counters are links, so the active one says
  `aria-current` instead of `aria-pressed` (RouterLink ignores the query and marked every counter as
  the current page), and the stack facts lost a `role="list"` that had no list items.
- **Found on the way.** The panel's container card printed Docker's state word as is; it is
  translated like the health check. The modal lifecycle probe mounts `Confirm` in an app of its own
  and now installs i18n, since the dialog translates its own buttons.
- **Server refusals.** About 40 refusals the interface can provoke were English sentences ("Stack not
  found", "Unknown service: x") and a translated interface showed them as an unexpected error. They
  are catalogue keys now, with the file, service or shell as values; `server-message-keys.ts` maps
  the fixed sentences an older agent or the original Dockge still sends, and a sentence with a name
  in it still arrives as an unexpected error from such an agent. `i18n-catalogue.test.ts` refuses a
  new sentence in `ValidationError`; only the protocol checks ("Stack name must be a string") stay
  English, since a well-formed client never provokes them.
- **The session read was rate limited.** The full browser suite of 51 tests failed its last four:
  after 60 session reads from one address with no quiet minute between them, Better Auth answered
  `/get-session` with 429 until a minute after the last allowed one, and the interface showed "The
  server did not respond". Its counter resets only after a whole window without a request, so a
  team behind a proxy without `DOCKGE_TRUST_PROXY`, which shares one bucket, would hit the same
  wall. `/get-session` is exempt: the signed cookie is the secret and the socket handshake does the
  same lookup unlimited. Sign-in, setup and TOTP keep their limits; `auth-boundaries.test.ts` reads
  the session 80 times from one address and fails on the 61st without the exemption.

### 2026-09-26: 0.0.14 goes out as a release candidate first

`v0.0.14-rc.4` is a GitHub prerelease. Every tag so far was stable, so the prerelease branch of
`release.yml` has never run, and the update from the web interface needs a starting point that
already carries the new updater. The review VPS reached rc.3 with the host command, then updates
from About with **Include beta releases** on, to rc.4. `latest` stays on 0.0.13 until the stable
tag; its notes are `docs/releases/0.0.14.md`, the candidate's `0.0.14-rc.4.md`. The tags
`v0.0.14-rc.1` and `v0.0.14-rc.2` stopped at the release gate and have no release; a failed
candidate's number is skipped rather than the pushed tag moved.

The first CI run of the candidate caught two things the local runs could not. Compose 2.38 on
the runner refuses `memswap_limit: "-1"` as a size while 5.5 accepts it; the converter writes the
number -1, which both take, and all 51 commands of the corpus pass `config` on both versions. The
reference screenshot job, new in this release, ran `npm ci` in the Playwright image, where npm's
default node-gyp build of better-sqlite3 has no `make`; the scene loads no native module, so the
job installs with `--ignore-scripts`, reproduced in the same image with 71 passed.

The release gate of rc.1 then caught the third: the helper of the web interface runs the updater
with the Compose of the panel's image (5.5), while the host recorded the deployment with its own
(2.38 on the runner). Compose 2 writes a bind's `create_host_path` only when true and Compose 5
only when false, so `"bind": {}` means opposite things, the preview reported `volumes` as changing
and a run of the same version recreated the panel instead of ending in no change. The updater now
asks its Compose with a one-line probe what an omitted value means and writes the value into every
bind of a snapshot, so both versions render the release file to the same bytes and read a snapshot
the same way; a recorded snapshot from before is read as the current Compose would render it.

The CI run of that fix failed the browser suite once, on the Cmd+V paste: the terminal showed
`echo mcd` for a typed `echo cmd`, and eight local repeats reproduced `ehco` and `cdm`. Not a flaky
test: since 0.0.1 the transport middleware admitted each packet the moment its own permission check
finished, and the agent proxy then checked again before dispatching, so a check that took a turn
longer let the next key overtake it. Packets are now checked side by side and admitted in arrival
order (`admitInOrder` in `backend/util-server.ts`), and the proxy forwards each endpoint's events
one after another. 25 repeats of the paste test and 8 of both terminal specs passed.

The release gate of rc.2 passed every amd64 check and stopped on arm64, at the helper's run of the
same version: `docker pull` answered `cannot overwrite digest`. The gate runs arm64 under QEMU on an
amd64 runner. The host pulls with `DOCKER_DEFAULT_PLATFORM`, but the helper container does not
inherit it, so the updater's plain `docker pull` asked the daemon for its own amd64 variant of the
index digest, and the classic image store keeps one image per digest reference. The updater now
pulls `--platform linux/<its own architecture>`, which it already required of the image afterwards.
Reproduced in a `docker:28-dind` with the classic store: a pinned pull, then a plain one fails with
the same message, and a pinned one passes again.

### 2026-09-26: no reserved scrollbar gutter, a socket note that says what to do

The strip right of the header, left open on 2026-09-17 as a trade-off, is closed by removing
`html { scrollbar-gutter: stable }`. The gutter came in with the redesign without a stated reason;
upstream Dockge never had it. On a system with classic scrollbars it left 15px of page background
beside the header on every page too short to scroll, which is open Bootstrap issue #42546. The
jump it was meant to prevent did not go away either: Bootstrap 5.3 modals add the scrollbar width
as body padding on their own, so on a scrolling page the two together moved the content 15px left
when a modal opened. Vue libraries reserve the gutter only while a dialog locks the scroll (Quasar,
VitePress, Vuetify's block strategy, Element Plus's lock screen), or scroll an inner container. The
cost is the one every such app pays: content 15px wider on pages that do not scroll. The 28 desktop
reference screenshots were re-approved for exactly that; phone screens use overlay scrollbars and
did not change.

The Docker socket note in About now says why the risk exists, that it is not a fault, and what
reduces it, with a link to the threat model instead of one sentence about root.

### 2026-09-26: dependencies brought up to what the release age allows

Everything published by 2026-09-19 was taken, the edge `min-release-age=7` in `.npmrc` sets:
better-auth 1.7.5, zod 4.6.5, yaml 2.9.1, type-fest 5.10.0, tsx 4.23.13, Vue 3.5.43, vite 8.3.0,
bootstrap-vue-next 1.2.1, vue-i18n 11.4.12, sass 1.104.1, ESLint 10.11 with its plugins,
Playwright 1.63.0 and its image, Node 24.21.0, Go 1.27.1, and the actions pinned in `release.yml`.
The visual suite passed in the new Playwright image without a re-approval.

vue-tsc moved from 2 to 3, which checks the type of a `v-model` event. vue-codemirror6 emits the
document as a string but types it as an optional string or CodeMirror `Text`, so the three editors
bind the value and the event separately through `editorText` instead of `v-model`.

Better Auth 1.7.3 reverted the account `issuer` that 1.7.0 introduced: every installation from
0.0.10 to 0.0.13 has a required `issuer` column and a unique index on it, and the newer library no
longer writes it, so the next account created would have failed. The Knex migration
`2026-09-26-1200-account-issuer` drops both, following the SQLite steps of the upgrade guide, and
does nothing on a fresh installation, where the auth tables do not exist yet; its `down` gives
every password account back the `local:credential` value 1.7.2 wrote. Tested on a copy of a real
0.0.13 database: the existing account signs in and a new one can be added. An older panel refuses a
database with a migration it does not know, as before; the updater restores the data backup on a
rollback. Since 1.7.4 the library also checks the schema as the instance starts, so its migrations
now run before the instance is built; the other way round a fresh installation logged a
"Database schema mismatch" error about tables it was just about to create.

Held back, with the reason:
- everything newer than the release age, to be taken after it matures: better-auth 1.7.6,
  socket.io 4.8.4, vite 8.3.1, sass 1.105, vue-codemirror6 1.7.0, @types/node 24.19, Node 22.23.3,
  the MCP SDK 1.30.1. `npm update --before` stops on the MCP server and client 2.1.0 pinned on
  2026-09-24 (published 09-23), so the transitive dependencies were not refreshed as a whole;
- dotenv 18: a major with four patch releases in its first week, it waits for the 14 day major
  cooldown Dependabot uses;
- TypeScript 7: vue-tsc still cannot run on it;
- @types/node 26: the types follow the Node 24 runtime.

### 2026-09-27: 0.0.14-rc.4 before the stable tag

rc.3 passed its release gate, but the dependency update and the `issuer` migration above came after
it, and only the gate has Compose 2.38, arm64 under QEMU and the update from the 0.0.13 release. A
stable tag that stopped there would lose its number, so they go out as rc.4 first. rc.4 is also the
first candidate an installation reaches from About: the review VPS runs rc.3, and its update to
rc.4 is the first real cutover from the page, with a schema change and the data snapshot. 0.0.14
follows from the same code with only the version changed.

The migration ran against the schema of the review VPS, a database that went from 0.0.3 to rc.3,
with an invented owner and no data from the server: the column and its index are gone, the owner
signs in, a viewer created through `usersCreate` signs in, and Better Auth reports no mismatch; a
fresh data directory starts without one either. The local checks ran on Node 24.21.0 with its npm
11.19, as CI does. That npm warns about install scripts not listed in `allowScripts`
(better-sqlite3, node-pty, esbuild, vue-demi, @parcel/watcher) but still runs them, and the native
modules load from their prebuilds either way.

### 2026-09-27: feedback on rc.4 from About

The owner tried rc.4 on the review VPS and asked for four changes before the stable tag.

- **One button for the check.** After **Check for updates** found a release, About showed a second
  button, "Prepare update to X", that only started the dry run. The owner read it as a step the
  panel could take by itself. The dry run now follows the check that found a newer release, and has
  no button of its own; an expired or closed check is repeated with the same button. Opening About
  does not start a dry run: each one runs a helper container and verifies the release over the
  network, and a visit is not a request.
- **The schema warning** says what happens in the owner's words: the version changes the data in
  the database, a backup is made before the update, and a rollback restores it.
- **Dialogs stand in the middle of the screen**, like the update overlay; the password dialog sat at
  the top. On a phone they stay at the top, so the on-screen keyboard does not cover the field.
- **The step list of the overlay** is a segmented bar, chosen by the owner from four mockups
  (vertical timeline, stepper with a line, segmented bar, pills). Above it stand the number and name
  of the current step and the elapsed time; below it the names of the steps, which a narrow screen
  leaves to the screen reader. A rollback segment keeps the attention colour.

0.0.14 goes out as the stable tag with these changes, without an rc.5: the owner's decision. The
entry above said the stable tag would differ from rc.4 in the version only; these changes touch the
page alone - About, the overlay, the dialog position and two strings - and none of the server, the
updater, the release files or the migrations, which is what rc.4 and its gate were for. The stable
tag runs the whole release gate itself before `latest` moves off 0.0.13.

### 2026-09-27: the installer output in sections

A dry run on a fresh Debian host without Docker printed a single line, `Required command: docker`:
`curl` and `sha256sum` had been checked silently, the loop stopped at the first missing command,
and nothing said what to do. The owner asked for output that does not run together and for every
prerequisite to be checked at the start. Of the layouts offered the owner chose sections with a
status column (`ok`, `missing`, `failed`, `warning`) and the fix under the line, with colour in a
terminal only.

- **The bootstrap** (`install.sh`) checks the platform and the `curl`, `sha256sum` and `docker`
  commands first and lists every unmet requirement at once, with a hint, before it downloads
  anything. Its Updater section shows the Cosign checksum and the signature of the updater; a
  failed download or verification shows the command's own words.
- **Docker is still not run before the signature check**, as `test/install/run.sh` requires: the
  bootstrap only looks for the command. The daemon, the Engine and Compose versions and the Compose
  plugin are checked by the verified updater in its Docker section. The versions are compared with
  the release minimums right after the release is verified, not after the plan.
- **The updater** prints Docker, Release, Plan, the operation step by step, Recovery and Done. A
  failure names the step that failed, its cause and a hint, and one closing line says where the
  installation stands. Recovery prints the original failure once, then its own steps.
- **A fresh installation** used to end with "Update succeeded" and no address. Done gives the
  address, the command that shows the setup code (never the code itself) and the command for
  updates.
- **Colour** only when the stream is a terminal, `NO_COLOR` is unset and `TERM` is not `dumb`. A
  running step is shown on a terminal and overwritten by its result. Problems go to stderr.
- **The panel is not affected**: with `--progress json` the human text stays on stderr and stdout
  carries JSON lines only; the error text of the result line is unchanged. `--status` keeps a plain
  one-line error.

It reaches installations with the next release: `install.sh` and the updater are release assets,
and 0.0.14 still prints the old text after its bootstrap.

Found on the way and not fixed: a fresh installation interrupted after `.env` is written and before
the panel starts cannot be repeated. The installer refuses an existing `.env`, `--update` finds no
installed state and looks for a vendor Compose file that is not there, and `--rollback` and
`--resume` do not accept `failed-before-cutover` without a previous deployment. The only way out is
to remove `.env` and `.dockge2` by hand. It is in the implementation plan.

### 2026-09-27: one line to install

The README block downloaded the installer to `/tmp`, opened it in `less`, ran a dry run and then
installed with `--yes`. Pasted whole, it installed right after the preview without a chance to
stop, and on a shell without bracketed paste `less` took the rest of the paste as keystrokes. The
owner asked for the simplest way in the README, since that is where people install from.

- **The README shows** `curl -fsSL .../install.sh | sudo bash`. The updater already prints the
  plan and asks before any change, so the dry run and `--yes` left the README. Reading the script
  first stays in `docs/installation.md`, as its own path.
- **The question comes from `/dev/tty`**, not stdin, which under the pipe is the script. Checked on
  Debian 13 with sudo's `use_pty`: a script piped into `sudo bash` reads the answer from the
  terminal. The question is now written to the terminal as well, so it is seen when stderr is
  redirected. Without a terminal the run stops before any change, with a hint to use `--dry-run`
  and `--yes`.
- **A download cut short runs nothing**: the body of `install.sh` is one `{ ... }` group, which bash
  reads in full before it runs any of it. Without it, half of the 0.0.14 script printed the Host
  section before the syntax error. `bootstrap.test.mjs` pipes cut versions of the script into bash
  and checks that nothing is downloaded or started.
- **`n` is a cancellation, not a failure**: it used to print `update cancelled before cutover` as a
  failed step, also for a fresh install. Now it ends with "Cancelled: nothing was installed or
  changed."

The group and the new texts reach installations with the next release. The 0.0.14 installer
already works through the pipe and asks its own question.

### 2026-09-27: the address and the setup code at the end

The owner installed 0.0.14 on a fresh host with the one line and got "Update succeeded" and nothing
about where to go next. The Done section of the unreleased updater was not enough either: it
printed `http://SERVER:5001` and the command that shows the setup code, not the code.

- **Addresses**: Done lists the IPv4 addresses of the host's interfaces, or its IPv6 ones when it
  has no IPv4, three at most, without loopback, link-local and Docker's bridges. When every one is
  private, a line says to use the public address from outside. With none found it keeps `SERVER`.
  The public address is not asked from an outside service.
- **The setup code itself** is shown when stdout is a terminal (`/proc/self/fd` points at a
  `/dev/pts` or `/dev/tty` device; `/dev/null` is a character device too, so that test is not
  used). Captured output, such as a cloud-init log that outlives the setup, gets the `cat` command.
  This replaces "never the code itself" from the entry on the installer output: the person who ran
  the installer as root can read the file anyway, and the log was the only real exposure.
- The code is read with `O_NOFOLLOW`; when it cannot be read, as for a user without root, the
  command is shown.

Checked on local Docker with an isolated project: the printed address opened the panel.
