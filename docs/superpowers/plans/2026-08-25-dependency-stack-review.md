# Dependency Stack Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Провести ревью Dockge, обновить поддерживаемые зависимости и заменить подтверждённо устаревшие runtime-библиотеки без изменения формата существующей базы данных и пользовательских сценариев.

**Architecture:** Оставить Vue 3 + Vite + Express + Socket.IO + Knex, но обновить их до поддерживаемых веток. Удалить `redbean-node` и старый форк SQLite: доступ к трём существующим таблицам будет выполняться через Knex и `better-sqlite3`, а миграции останутся Knex-миграциями. Для UI и служебных функций заменить заброшенные пакеты на поддерживаемые аналоги или встроенные возможности Node/Web Platform.

**Tech Stack:** Node.js 22.23.2 or 24.19.0, TypeScript, Vue 3, Vite, Express 4.x, Socket.IO 4.x, Knex 3.x, better-sqlite3, CodeMirror 6, ESLint flat config.

**Spec:** Пользовательский запрос в текущем диалоге: код-ревью проекта, обновление библиотек стека и замена мёртвых библиотек.

## Global Constraints

- Разрешить только `engines.node` `22.23.2 || 24.19.0`; основным runtime выбрать 24.19.0.
- Не менять формат `data/dockge.db`, имена таблиц `user`, `setting`, `agent` и существующие миграции.
- Не трогать незакоммиченный пользовательский `AGENTS.md` в исходной рабочей копии.
- Проверять каждый этап командами `npm run lint`, `npm run check-ts`, `npm run build:frontend` и `npm audit`.
- Не добавлять новые зависимости, если задача решается встроенным API Node.js или уже используемым Knex.

---

### Task 1: Зафиксировать исходное состояние и карту зависимостей

**Files:**
- Read: `package.json`
- Read: `package-lock.json`
- Read: `.github/workflows/ci.yml`
- Read: `backend/database.ts`, `backend/models/*.ts`, `frontend/vite.config.ts`
- Create: `docs/superpowers/plans/2026-08-25-dependency-stack-review.md`

**Interfaces:**
- Consumes: текущий manifest, lock-файл, исходные результаты `npm ci`, lint, проверки TypeScript, сборки и аудита.
- Produces: список прямых зависимостей для обновления, удаления или замены и зафиксированные исходные предупреждения.

- [x] **Step 1: Проверить состояние ветки и исходные файлы**

Run:

```bash
git status --short --branch
git diff -- package.json package-lock.json backend frontend common extra .github
```

Expected: рабочая ветка изолирована; пользовательские изменения вне области задачи отсутствуют.

- [x] **Step 2: Установить lock-файл и собрать исходные метрики**

Run:

```bash
npm ci --no-audit --no-fund
npm run lint
npm run check-ts
npm run build:frontend
npm audit --json
```

Expected: исходные `lint`, проверка TypeScript и сборка завершаются успешно; результаты аудита сохранены для сравнения.

- [x] **Step 3: Проверить фактическое использование кандидатов на замену**

Run:

```bash
rg -n --glob '!node_modules/**' --glob '!package-lock.json' \
  'redbean-node|@louislam/sqlite3|limiter-es6-compat|thememirror|vite-plugin-compression|vue-toastification|timezones-list|xterm-addon-web-links|command-exists' \
  backend common frontend extra package.json
```

Expected: для каждого удаляемого пакета есть точный список исходных файлов и импортов.

---

### Task 2: Обновить manifest и заменить устаревший инструментарий

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`
- Create: `eslint.config.js`
- Delete: `.eslintrc.cjs`
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Consumes: список пакетов из Task 1 и ограничения Node.js из `package.json`.
- Produces: воспроизводимая установка без deprecated прямых зависимостей и конфигурация ESLint/Vite, совместимая с обновлённым toolchain.

- [x] **Step 1: Обновить поддерживаемые прямые зависимости**

Use the package manager to update the manifest and lock-file to current stable versions compatible with Node.js 22.23.2 and 24.19.0. The update must include the Vite 8-compatible `@vitejs/plugin-vue`, Vue I18n 11, current Vue 3 patch, Socket.IO 4.8.x, Express 4.22.x, Knex 3.x, YAML 2.9.x, current Sass, TypeScript 5.9.x (the installed typescript-eslint parser does not yet support TypeScript 7), TSX, Vue Router 4.x, CodeMirror packages and Font Awesome packages.

Run:

```bash
npm install --save \
  @homebridge/node-pty-prebuilt-multiarch@0.14.1 \
  @inventage/envsubst@0.17.0 \
  better-sqlite3@13.0.3 \
  bcryptjs@3.0.3 \
  check-password-strength@3.0.0 \
  composerize@1.7.6 \
  croner@10.0.1 \
  dayjs@1.11.23 \
  dotenv@17.4.2 \
  express@4.22.2 \
  express-static-gzip@3.0.1 \
  http-graceful-shutdown@4.0.0 \
  jsonwebtoken@9.0.3 \
  jwt-decode@4.0.0 \
  knex@3.3.0 \
  limiter@3.0.0 \
  promisify-child-process@5.0.1 \
  semver@7.8.5 \
  socket.io@4.8.3 \
  socket.io-client@4.8.3 \
  ts-command-line-args@2.5.1 \
  tsx@4.23.12 \
  type-fest@5.8.0 \
  yaml@2.9.0

npm install --save-dev \
  @actions/github@9.1.1 \
  @codemirror/lang-python@6.1.7 \
  @codemirror/lang-yaml@6.1.3 \
  @codemirror/theme-one-dark@6.1.2 \
  @fontsource/jetbrains-mono@5.3.0 \
  @fortawesome/fontawesome-svg-core@7.3.1 \
  @fortawesome/free-regular-svg-icons@7.3.1 \
  @fortawesome/free-solid-svg-icons@7.3.1 \
  @fortawesome/vue-fontawesome@3.3.3 \
  @eslint/js@10.0.1 \
  @typescript-eslint/eslint-plugin@8.68.0 \
  @typescript-eslint/parser@8.68.0 \
  @vitejs/plugin-vue@6.0.8 \
  @xterm/addon-fit@0.11.0 \
  @xterm/xterm@6.0.0 \
  bootstrap@5.3.8 \
  bootstrap-vue-next@1.0.1 \
  codemirror@6.0.1 \
  concurrently@10.0.5 \
  cross-env@10.1.0 \
  eslint@10.9.1 \
  eslint-plugin-jsdoc@64.2.1 \
  eslint-plugin-vue@10.10.0 \
  sass@1.103.1 \
  typescript@5.9.3 \
  unplugin-vue-components@32.1.0 \
  vite-plugin-compression2@2.5.3 \
  vue@3.5.41 \
  vue-codemirror6@1.6.1 \
  vue-eslint-parser@10.4.1 \
  vue-i18n@11.4.10 \
  vue-qrcode@2.2.2 \
  vue-router@4.5.1 \
  vue3-toastify@0.2.9 \
  wait-on@9.1.0
```

Remove the unused or replaced packages in the same manifest update: `@louislam/sqlite3`, `command-exists`, `limiter-es6-compat`, `mysql2`, `redbean-node`, `thememirror`, `timezones-list`, `vite-plugin-compression`, `vue-toastification`, `xterm-addon-web-links`, and unused `@types/*` packages whose types are now supplied by their runtime packages.

Expected: `package.json` contains one maintained implementation per responsibility; `package-lock.json` is regenerated by npm and no longer resolves the old SQLite fork, `redbean-node`, or the deprecated xterm web-links package.

- [x] **Step 2: Migrate ESLint to flat configuration**

Create `eslint.config.js` using the installed `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `eslint-plugin-vue`, and `eslint-plugin-jsdoc`. Preserve the existing project rules: four-space indentation, double quotes, semicolons, Unix line endings, Vue 3 recommended rules, and current warning-only treatment of camelcase and unused variables. Apply the TypeScript parser to `*.ts` and Vue parser to `*.vue` without linting generated `frontend-dist` or dependencies.

Run:

```bash
npm run lint
```

Expected: ESLint starts without legacy `.eslintrc` warnings; only pre-existing non-blocking warnings remain, or the warning count decreases.

- [x] **Step 3: Migrate the compression plugin API**

In `frontend/vite.config.ts`, replace the old default import and two plugin instances with the maintained named API:

```ts
import { compression } from "vite-plugin-compression2";

compression({
    include: viteCompressionFilter,
    algorithms: [ "gzip", "brotliCompress" ],
}),
```

Keep both `.gz` and `.br` artifacts and preserve the existing asset filter behavior. Update the CI action versions to current Node 22-compatible checkout/setup-node releases while retaining the existing matrix and commands.

Expected: the frontend build creates gzip and Brotli files without absolute-path artifacts in the log and without the deprecated `vite-plugin-compression` package.

---

### Task 3: Replace dead runtime libraries and adapt their call sites

**Files:**
- Modify: `backend/rate-limiter.ts`
- Modify: `backend/terminal.ts`
- Modify: `frontend/src/pages/Compose.vue`
- Modify: `frontend/src/components/settings/GlobalEnv.vue`
- Modify: `frontend/src/util-frontend.ts`
- Modify: `frontend/src/main.ts`
- Modify: `frontend/src/components/TwoFADialog.vue`
- Modify: `frontend/src/mixins/socket.ts`

**Interfaces:**
- Consumes: maintained packages from Task 2.
- Produces: equivalent rate limiting, terminal shell detection, editor theme, toast behavior, timezone list and JWT decoding without the stale packages.

- [x] **Step 1: Replace the compatibility rate limiter and command-exists package**

In `backend/rate-limiter.ts`, import `RateLimiter` and `RateLimiterOpts` from `limiter`, keep the three existing limits and `fireImmediately: true`, and remove the compatibility-package comment.

In `backend/terminal.ts`, replace `command-exists` with a small local `commandExistsSync(command: string): boolean` based on `execFileSync(process.platform === "win32" ? "where.exe" : "which", [command], { stdio: "ignore" })`. Use it only for the existing PowerShell selection.

Expected: no runtime import of `limiter-es6-compat` or `command-exists`; rate limiting and Windows shell selection keep their existing behavior.

- [x] **Step 2: Replace ThemeMirror with the maintained CodeMirror theme package**

Change both editor imports from:

```ts
import { dracula as editorTheme } from "thememirror";
```

to:

```ts
import { oneDark as editorTheme } from "@codemirror/theme-one-dark";
```

Keep the editor extension arrays unchanged apart from the theme extension.

Expected: both YAML and environment editors still render with a dark CodeMirror theme and `thememirror` is absent from the dependency graph.

- [x] **Step 3: Remove the timezone data dependency**

In `frontend/src/util-frontend.ts`, replace the `timezones-list` import with `Intl.supportedValuesOf("timeZone")`, preserving the current output shape `{ name, value, time }`, UTC offset sorting and the existing try/catch for unsupported zones. Add a fallback to `[]` only when `Intl.supportedValuesOf` is unavailable.

Expected: `timezoneList()` still returns valid IANA timezone values and no longer bundles a separately maintained timezone list; the currently hidden settings sections remain behaviorally unchanged.

- [x] **Step 4: Replace Vue Toastification RC with Vue3 Toastify**

In `frontend/src/main.ts`, import `toast` from `vue3-toastify`, import its CSS, and remove `app.use(Toast, ...)` and `useToast()`. Keep the root methods `toastRes`, `toastSuccess` and `toastError`, calling `toast.success` or `toast.error` with the existing localized strings and the equivalent auto-close options.

In `frontend/src/components/TwoFADialog.vue`, replace `useToast()` with the named `toast` import. In `frontend/src/util-frontend.ts`, replace `POSITION.BOTTOM_RIGHT` and old option names with the maintained library's position and duration types, or remove the helper if it has no callers after the migration.

Expected: setup, login, validation and 2FA errors still display localized success/error notifications; `vue-toastification` is absent from source and lock-file.

- [x] **Step 5: Adapt JWT decoding and remove dead imports**

Change `frontend/src/mixins/socket.ts` to the `jwt-decode` v4 named import:

```ts
import { jwtDecode } from "jwt-decode";
```

Update the call site only if TypeScript reports the v4 signature change. Remove imports that become unused during the migration and keep the public component methods unchanged.

Expected: `npm run check-ts` reports no new errors and token-based login still decodes the same payload shape.

---

### Task 4: Remove redbean-node and the old SQLite fork

**Files:**
- Modify: `backend/database.ts`
- Modify: `backend/models/user.ts`
- Modify: `backend/models/agent.ts`
- Modify: `backend/settings.ts`
- Modify: `backend/agent-manager.ts`
- Modify: `backend/socket-handlers/main-socket-handler.ts`
- Modify: `backend/dockge-server.ts`
- Modify: `backend/util-server.ts`
- Modify: `extra/reset-password.ts`

**Interfaces:**
- Consumes: Knex 3 and `better-sqlite3` from Task 2.
- Produces: a single database access layer with typed user, agent and setting records; existing migrations and database file compatibility are preserved.

- [x] **Step 1: Expose one Knex instance and configure better-sqlite3**

In `backend/database.ts`, replace the internal `knex/lib/dialects/sqlite3` patch and `@louislam/sqlite3` import with a typed Knex configuration using `client: "better-sqlite3"`. Store the instance in `Database.knexInstance`, expose `Database.getKnex(): Knex`, run the existing PRAGMA statements through `Database.getKnex().raw`, run migrations through `Database.getKnex().migrate.latest`, and close through `Database.getKnex().destroy()`.

Keep the existing `readDBConfig`, SQLite path, migration directory, WAL and synchronous settings. Remove Redbean setup, model autoloading, `Database.noReject`, and the retry loop that existed only for Redbean/tarn shutdown behavior.

Expected: a fresh temporary database creates the same three tables, and an existing database opens without a migration or schema-format change.

- [x] **Step 2: Replace bean models with typed Knex-backed records**

In `backend/models/user.ts`, keep `User.createJWT` and `User.resetPassword`, add a `User.fromRecord(record)` constructor/factory, and implement the minimum query helpers needed by the callers: find by username and active flag, find first user, and update password by id.

In `backend/models/agent.ts`, keep `endpoint` and `toJSON`, add `Agent.fromRecord`, `Agent.getAgentList`, and helpers for insert, find by URL, update name and delete by id. Return class instances so `afterLogin`, JWT creation and agent connection code continue to receive the same fields.

Expected: no file imports `Bean`, `BeanModel`, or `redbean-node`.

- [x] **Step 3: Convert settings and authentication queries to Knex**

Replace each `R.findOne`, `R.findAll`, `R.dispense`, `R.store`, `R.trash`, `R.getCell`, `R.getAll`, `R.exec`, and `R.knex` call with a parameterized Knex query. Preserve the current table names, column names, JSON parsing, cache invalidation, active-user checks, password hashing and JWT invalidation behavior.

For example, the setup flow must remain equivalent to:

```ts
const userCount = await Database.getKnex()("user").count("id as count").first();
if (Number(userCount?.count ?? 0) !== 0) {
    throw new Error("Dockge has been initialized. If you want to run setup again, please delete the database.");
}
await Database.getKnex()("user").insert({
    username,
    password: generatePasswordHash(password),
});
```

Use query bindings or Knex query-builder values for user input; do not interpolate usernames, URLs or settings into SQL strings.

Expected: setup, login, 2FA, agent add/update/remove, settings read/write and reset-password flows compile against the new data layer.

- [x] **Step 4: Exercise database compatibility before removing the old packages**

Run a backend smoke check with an isolated data directory:

```bash
tmp_data_dir="$(mktemp -d)"
DOCKGE_DATA_DIR="$tmp_data_dir" TEST_BACKEND=1 node --import tsx ./backend/index.ts
```

If the normal server remains running, stop it after the database initialization log and remove only the generated temporary directory.

Expected: no native-driver load error, no migration error, and no SQL query error. Do not delete any repository or user data.

---

### Task 5: Apply code-review fixes exposed by the audit

**Files:**
- Modify: `backend/util-server.ts`
- Modify: `backend/socket-handlers/main-socket-handler.ts`
- Modify: `backend/stack.ts`
- Modify: `backend/log.ts`
- Modify: `frontend/src/mixins/socket.ts`
- Modify: `frontend/src/i18n.ts`

**Interfaces:**
- Consumes: updated lint/type-check configuration and the refactored runtime dependencies.
- Produces: no newly introduced lint warnings, reachable validation errors, and no unnecessary compatibility suppressions.

- [x] **Step 1: Make ValidationError handling reachable**

In `backend/util-server.ts`, test `error instanceof ValidationError` before the generic `error instanceof Error` branch in `callbackError`. Preserve `ERROR_TYPE_VALIDATION`, `msg`, and `msgi18n` fields for validation failures.

Expected: validation errors sent through Socket.IO retain their validation type instead of being reported as generic errors.

- [x] **Step 2: Remove known unused imports and dead limiter declarations**

Remove unused `twoFaRateLimiter`, `PROGRESS_TERMINAL_ROWS`, `randomBytes` and unused loop variables where the updated lint run confirms they are not required. Keep security-sensitive behavior unchanged.

Expected: the existing 63-warning baseline decreases without changing runtime logic.

- [x] **Step 3: Simplify the Vue I18n import after upgrading to v11**

Replace the production browser subpath import and its `@ts-ignore` in `frontend/src/i18n.ts` with the supported package entry point if the v11 package exposes the same `createI18n` API. Keep the locale messages and legacy/composition settings unchanged.

Expected: no TypeScript suppression is needed solely because of the old Vue I18n subpath.

---

### Task 6: Full verification and final diff review

**Files:**
- Read: `git diff --stat`
- Read: `git diff -- package.json package-lock.json backend frontend common extra .github`

**Interfaces:**
- Consumes: all changes from Tasks 2–5.
- Produces: verified branch diff and a report separating fixed findings, residual risks and checks that could not run.

- [x] **Step 1: Reinstall from the final lock-file**

Run:

```bash
npm ci --no-audit --no-fund
```

Expected: clean install with no deprecated direct runtime package warnings for libraries removed by this plan.

- [x] **Step 2: Run required quality gates**

Run:

```bash
npm run lint
npm run check-ts
npm run build:frontend
npm audit --audit-level=high
```

Expected: all commands exit with code 0; audit has no high or critical findings attributable to direct dependencies.

- [x] **Step 3: Review dependency graph and changed files**

Run:

```bash
npm ls --depth=0
npm outdated --long
git status --short
git diff --check
git diff --stat
```

Expected: no old replacement package appears in the graph, no whitespace errors are reported, generated build output is ignored, and the diff contains only the planned source/configuration/manifest changes.

- [x] **Step 4: Report results with evidence**

Include the final versions, removed/replaced dead libraries, audit delta, exact verification commands and any remaining warnings or unverified browser-only behavior. Do not claim completion for a check whose command did not exit successfully.
