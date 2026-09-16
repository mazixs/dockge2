# Upstream Dockge Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перенести в dockge2 четыре полезных исправления upstream Dockge: #997 для защиты путей стеков, #979 для сохранения `.env`, #950 для корректного статуса Compose с одноразовыми контейнерами и #991 для сохранения восьмеричных значений YAML.

**Architecture:** Интегрировать исправления в существующие `Stack`, `yaml` и локальную обёртку `backend/child-process.ts`, не добавляя `promisify-child-process` и не подменяя реальные границы файловой системы или Docker заглушками. Общие проверки имени и пути будут выполняться до любого чтения, удаления или запуска Compose; классификация статуса будет разделена на чистую функцию и реальный вызов Docker.

**Tech Stack:** Node.js 22.23.2 or 24.19.0, TypeScript 5.9, Node test runner, c8, `yaml` 2.9, Docker Compose CLI, Knex/better-sqlite3.

**Spec:** Связанные upstream issues: [#994](https://github.com/louislam/dockge/issues/994), [#964](https://github.com/louislam/dockge/issues/964), [#806](https://github.com/louislam/dockge/issues/806), [#990](https://github.com/louislam/dockge/issues/990). Исходные PR: [#997](https://github.com/louislam/dockge/pull/997), [#979](https://github.com/louislam/dockge/pull/979), [#950](https://github.com/louislam/dockge/pull/950), [#991](https://github.com/louislam/dockge/pull/991).

## Global Constraints

- Изменения выполняются только в нашей ветке dockge2; план не предполагает отклонение или изменение PR в основном репозитории Dockge.
- Не добавлять зависимости для этих исправлений: использовать уже установленный `yaml` и локальный `backend/child-process.ts`.
- Не использовать monkey-patch `Terminal.exec`, `spawn` или файловой системы ради прохождения теста.
- Тесты path traversal и `.env` обязаны работать с реальными временными файлами; проверка статуса Docker должна включать реальный Docker Compose в отдельной Ubuntu CI-задаче.
- Любое имя стека должно быть проверено до `path.join`, `path.resolve`, чтения `.env`, запуска `docker compose` или рекурсивного удаления.
- Существующая совместимость с таблицами базы данных, форматами Compose и Node.js 22.23.2/24.19.0 сохраняется.
- После каждого завершённого задания запускать `npm run lint`, `npm run check-ts` и относящиеся к заданию тесты; перед завершением запустить полный `npm run check`, `npm run build:frontend` и `npm audit --omit=dev --audit-level=high`.

---

### Task 1: Защитить все операции стеков от path traversal (#994/#997)

**Files:**
- Modify: `backend/stack.ts:113-131,155-157,375-405`
- Modify: `test/backend/util-stack.test.ts:90-170`

**Interfaces:**
- Consumes: `DockgeServer.stacksDir`, существующую allow-list `^[a-z0-9_-]+$`, `ValidationError`.
- Produces: `Stack.validateName(name: string): void` и `Stack.getSafePath(server: DockgeServer, name: string): string`, используемые до каждой файловой или Docker-операции.

**Issue invariant:** Issue #994 подтверждает чтение `.env`/Compose за пределами `stacksDir` и рекурсивное удаление внешнего каталога; при `disableAuth` тот же путь становится неаутентифицированным. Поэтому проверка только в `save()` недостаточна.

- [x] **Step 1: Добавить реальные падающие тесты для небезопасных имён**

В `test/backend/util-stack.test.ts` расширить уже существующий тест с `mkdtemp()`:

```ts
const root = await mkdtemp(path.join(os.tmpdir(), "dockge-stack-path-"));
const stacksDir = path.join(root, "stacks");
const outsideDir = path.join(root, "outside");
await mkdir(stacksDir);
await mkdir(outsideDir);
await writeFile(path.join(outsideDir, ".env"), "SECRET=outside\n");
await writeFile(path.join(outsideDir, "compose.yaml"), "services: {}\n");

try {
    const server = { stacksDir } as never;
    await assert.rejects(
        Stack.getStack(server, "../outside"),
        (error: unknown) => error instanceof ValidationError,
    );
    assert.equal(await readFile(path.join(outsideDir, ".env"), "utf8"), "SECRET=outside\n");
} finally {
    await rm(root, { recursive: true, force: true });
}
```

Добавить отдельные проверки `Stack.validateName()` для `../outside`, `/tmp/outside`, `..\\outside`, пустого имени и имени с пробелом. Добавить положительный случай `ok-stack_1`, который реально читается из `stacksDir`.

Run:

```bash
node --import tsx --test test/backend/util-stack.test.ts
```

Expected: новые проверки сначала завершаются ошибкой на текущем коде, потому что `getStack()` вызывает `path.join()` до проверки имени.

- [x] **Step 2: Вынести проверку имени и безопасного пути**

В `backend/stack.ts` вынести проверку из `validate()`:

```ts
static validateName(name: string): void {
    if (!/^[a-z0-9_-]+$/.test(name)) {
        throw new ValidationError("Stack name can only contain [a-z][0-9] _ - only");
    }
}
```

Добавить `getSafePath()` с проверкой после нормализации:

```ts
static getSafePath(server: DockgeServer, name: string): string {
    Stack.validateName(name);
    const base = path.resolve(server.stacksDir);
    const resolved = path.resolve(base, name);
    const relative = path.relative(base, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ValidationError("Stack path is outside stacks directory");
    }
    return resolved;
}
```

Изменить `validate()` так, чтобы он вызывал `Stack.validateName(this.name)`, `path` так, чтобы он возвращал `Stack.getSafePath(this.server, this.name)`, а `getStack()` так, чтобы первым действием вычислял безопасный путь до любой проверки существования каталога. Не оставлять отдельный `path.join(server.stacksDir, stackName)` в `getStack()`.

Для уже существующего каталога перед операциями чтения/удаления проверить `lstat` и отклонить symlink самого каталога стека; это закрывает обход через разрешённое имя `linked`, указывающее наружу. Не менять доверенный корень `stacksDir` во время этой задачи.

- [x] **Step 3: Проверить, что все Socket.IO входы проходят через общий барьер**

Проверить вызовы `Stack.getStack()` в `backend/agent-socket-handlers/docker-socket-handler.ts` и `backend/agent-socket-handlers/terminal-socket-handler.ts`. Не дублировать регулярное выражение в обработчиках: они могут оставить проверку типа `string`, а содержательная проверка должна происходить в `getStack()`/`getSafePath()`.

Run:

```bash
rg -n "path\.join\([^\n]*stacksDir|Stack\.getStack|new Stack" backend test
```

Expected: `getStack()` и `Stack.path` используют один барьер; ни один обработчик не может выполнить `docker compose` с непроверенным именем.

- [x] **Step 4: Запустить тесты и зафиксировать результат**

Run:

```bash
npm run lint
npm run check-ts
node --import tsx --test test/backend/util-stack.test.ts
git diff --check
```

Expected: path traversal тесты используют только реальную временную файловую систему, не запускают Docker и не подменяют `Terminal.exec`; валидные стеки продолжают загружаться.

- [x] **Step 5: Commit**

```bash
git add backend/stack.ts test/backend/util-stack.test.ts
git commit -m "fix: validate stack paths before filesystem access"
```

---

### Task 2: Восстановить сохранение `.env` (#964/#979)

**Files:**
- Modify: `backend/stack.ts:178-205`
- Modify: `test/backend/util-stack.test.ts:90-153`

**Interfaces:**
- Consumes: `Stack.save(isAdd: boolean)`, `composeENV`, `fileExists`, существующие `PUID`/`PGID` настройки.
- Produces: сохранение `.env` при добавлении и обновлении стека с прежней семантикой пустого отсутствующего файла.

**Issue invariant:** Issue #964 показывает, что после изменения env-секции UI содержимое остаётся только в памяти и не записывается на диск. При этом пустой `.env`, которого раньше не было, не должен создаваться без необходимости.

- [x] **Step 1: Добавить падающие проверки реального файла**

В существующий тест сохранения стека добавить четыре сценария:

1. Новый стек с `composeENV = "KEY=initial\n"` создаёт `.env` с точным содержимым.
2. Повторное `save(false)` заменяет `.env` на `KEY=updated\n`.
3. Существующий `.env` после `save(false)` с пустым env становится пустым файлом.
4. Новый стек с пустым env не создаёт `.env`.

Проверки выполнять через `readFile` и `access`/`fileExists` в том же `mkdtemp()`; не подменять `fs` и не проверять только вызов функции.

Run:

```bash
node --import tsx --test test/backend/util-stack.test.ts
```

Expected: текущий код проходит YAML-тесты, но не записывает непустой `.env`, поэтому первый сценарий падает.

- [x] **Step 2: Реализовать запись `.env` после подготовки каталога**

В `Stack.save()` после проверки каталога записать Compose YAML, затем выполнить:

```ts
const envPath = path.join(dir, ".env");
if (await fileExists(envPath) || this.composeENV.trim() !== "") {
    await fsAsync.writeFile(envPath, this.composeENV, "utf8");
    if (process.env.PUID && process.env.PGID) {
        fs.chownSync(envPath, Number(process.env.PUID), Number(process.env.PGID));
    }
}
```

Сохранить существующую смену владельца Compose-файла. Не создавать `.env` для нового стека с пустой строкой, но очищать уже существующий `.env`, когда пользователь удалил env-содержимое. Путь брать через безопасный `this.path` из Task 1.

- [x] **Step 3: Проверить права и отсутствие утечки содержимого**

Не включать `composeENV` в исключения, сообщения или логи. При наличии `PUID`/`PGID` проверить только числовые значения до `chown`; не добавлять тест, требующий root-права на CI. Тест должен подтверждать байт-в-байт содержимое файла и отсутствие файла в сценарии пустого нового env.

- [x] **Step 4: Запустить тесты и зафиксировать результат**

Run:

```bash
npm run lint
npm run check-ts
node --import tsx --test test/backend/util-stack.test.ts
git diff --check
```

Expected: все четыре сценария сохранения `.env` проходят на реальной файловой системе.

- [x] **Step 5: Commit**

```bash
git add backend/stack.ts test/backend/util-stack.test.ts
git commit -m "fix: persist stack environment files"
```

---

### Task 3: Исправить статус Compose с clean-exit init-контейнерами (#806/#950)

**Files:**
- Modify: `backend/child-process.ts:1-128`
- Modify: `backend/stack.ts:20-21,301-373`
- Create: `test/backend/stack-status.test.ts`
- Create: `test/fixtures/clean-exit-stack.compose.yaml`
- Create: `test/backend/stack-docker.integration.test.ts`
- Modify: `package.json:8-16`
- Modify: `.github/workflows/ci.yml:16-49`

**Interfaces:**
- Consumes: текущие `Stack.statusConvert()`, `spawn(command, args, options)` и Docker Compose CLI.
- Produces: `Stack.resolveContainerStatuses(entries: readonly DockerPsEntry[]): number`, `Stack.resolveComposeStatus(composeStack: ComposeLsEntry): Promise<number>` и opt-in реальный Docker-интеграционный тест.

**Issue invariant:** Issue #806 описывает корректный стек как `exited(N), running(M)`, когда одноразовый init-контейнер завершился с кодом 0. PR #950 правильно требует, чтобы все завершившиеся контейнеры имели код 0 и хотя бы один контейнер оставался running.

- [x] **Step 1: Написать падающие чистые тесты классификации**

Создать `test/backend/stack-status.test.ts` и проверять без заглушек функций приложения, передавая в чистую функцию реальные структуры данных:

```ts
assert.equal(Stack.resolveContainerStatuses([
    { State: "running", Status: "Up 10 seconds" },
    { State: "exited", Status: "Exited (0) 10 seconds ago" },
]), RUNNING);

assert.equal(Stack.resolveContainerStatuses([
    { State: "running", Status: "Up 10 seconds" },
    { State: "exited", Status: "Exited (1) 10 seconds ago" },
]), EXITED);

assert.equal(Stack.resolveContainerStatuses([
    { State: "exited", Status: "Exited (0) 10 seconds ago" },
]), EXITED);

assert.equal(Stack.resolveContainerStatuses([
    { State: "restarting", Status: "Restarting" },
]), EXITED);
```

Добавить проверку, что malformed `Exited (...)` и пустой список дают `EXITED`, то есть неизвестное состояние не повышается до `RUNNING`.

Run:

```bash
node --import tsx --test test/backend/stack-status.test.ts
```

Expected: тесты не проходят до появления чистой функции классификации.

- [x] **Step 2: Добавить timeout и ограничение вывода в локальную обёртку процесса**

Расширить `SpawnOptions` полем `timeoutMs?: number`. В `spawn()` после создания процесса установить таймер только при заданном `timeoutMs`; по срабатыванию вызвать `child.kill(killSignal ?? "SIGTERM")`, сохранить ошибку `Process timed out after ${timeoutMs}ms` и очистить таймер в обработчике `close`. Сохранить текущие `maxBuffer`, `stdout`, `stderr`, код завершения и отсутствие `shell: true`.

Добавить в `test/backend/child-process.test.ts` реальный дочерний процесс `process.execPath`, который ждёт дольше лимита, и проверить, что Promise завершается ошибкой с `killed === true`. Не использовать fake timers и не подменять `child_process.spawn`.

- [x] **Step 3: Реализовать получение статусов через существующий `spawn`**

В `backend/stack.ts` определить узкие интерфейсы:

```ts
interface ComposeLsEntry {
    Name: string;
    Status: string;
    ConfigFiles?: string;
}

interface DockerPsEntry {
    State?: string;
    Status?: string;
}
```

Добавить `getSingleComposeStatus(composeName: string): Promise<readonly DockerPsEntry[] | null>`, который запускает только массив аргументов:

```ts
["ps", "-a", "--filter", `label=com.docker.compose.project=${composeName}`, "--format", "json"]
```

Параметры вызова: `encoding: "utf8"`, `maxBuffer: 256 * 1024`, `timeoutMs: 5000`. Разобрать формат Docker как JSON Lines, пропустить только пустые строки, а при ошибке процесса, превышении лимита или некорректном JSON вернуть `null`.

Добавить чистую `resolveContainerStatuses()` с fail-closed-правилами:

- `RUNNING` возвращается только при наличии хотя бы одного `State === "running"`;
- каждый `State === "exited"` обязан иметь `Status`, соответствующий `/^Exited\\s+\\(0\\)/i`;
- любой другой state, malformed exit code или пустой список возвращает `EXITED`.

Добавить `resolveComposeStatus()`: сначала вызвать текущий `statusConvert()`, обратиться к `docker ps` только для статуса `EXITED`, в исходной строке которого есть `running`, и вернуть результат `resolveContainerStatuses()`. В `getStackList()` и `getStatusList()` заменить прямой вызов `statusConvert()` на `resolveComposeStatus()`.

Не переносить из upstream PR зависимость `promisify-child-process`: текущая обёртка уже используется проектом и дополнительно ограничивает вывод.

- [x] **Step 4: Добавить реальный Docker Compose fixture**

Создать `test/fixtures/clean-exit-stack.compose.yaml`:

```yaml
services:
  init:
    image: alpine:3.20
    command: ["sh", "-c", "exit 0"]
  app:
    image: alpine:3.20
    command: ["sh", "-c", "sleep 300"]
```

Создать `test/backend/stack-docker.integration.test.ts`, который при `DOCKGE_DOCKER_INTEGRATION=1`:

1. генерирует уникальное имя проекта;
2. запускает `docker compose -p <name> -f <fixture> up -d` через аргументный массив и ждёт завершения команды;
3. вызывает `Stack.getStatusList()` и проверяет, что проект имеет статус `RUNNING`;
4. в `finally` выполняет `docker compose -p <name> -f <fixture> down -v` и проверяет успешный код.

Без переменной окружения тест должен быть пропущен с явной причиной; этот skip не используется как доказательство корректности и не должен быть единственной проверкой. Классификация также обязана покрываться чистыми unit-тестами из Step 1.

- [x] **Step 5: Подключить Docker-проверку только к Linux CI**

В `package.json` добавить:

```json
"test:docker-integration": "DOCKGE_DOCKER_INTEGRATION=1 node --import tsx --test test/backend/stack-docker.integration.test.ts"
```

В `.github/workflows/ci.yml` добавить отдельный job `docker-integration` на `ubuntu-latest` и Node `24.19.0`, который выполняет `npm ci --no-audit --no-fund`, затем `npm run test:docker-integration`. Основную матрицу Windows/macOS/Linux оставить для unit-тестов и проверки TypeScript.

- [x] **Step 6: Запустить проверки и зафиксировать результат**

Run:

```bash
npm run lint
npm run check-ts
node --import tsx --test test/backend/child-process.test.ts test/backend/stack-status.test.ts
DOCKGE_DOCKER_INTEGRATION=1 npm run test:docker-integration
git diff --check
```

Expected: unit-тесты используют реальную дочернюю программу, интеграционный тест — реальный Docker Compose, а malformed/failed Docker output не переводит стек в `RUNNING`.

- [x] **Step 7: Commit**

```bash
git add backend/child-process.ts backend/stack.ts test/backend/child-process.test.ts test/backend/stack-status.test.ts test/backend/stack-docker.integration.test.ts test/fixtures/clean-exit-stack.compose.yaml package.json .github/workflows/ci.yml
git commit -m "fix: resolve compose status from container states"
```

---

### Task 4: Сохранить octal `tmpfs.mode` при копировании YAML (#990/#991)

**Files:**
- Modify: `common/util-common.ts:4,215-287`
- Modify: `test/common/util-common.test.ts:133-148`

**Interfaces:**
- Consumes: `yaml` `Document`, `Scalar`, `isCollection`, `isScalar` и существующее сопоставление YAML-узлов по содержимому.
- Produces: `copyYAMLComments()` с сохранением исходного octal-формата и всех существующих комментариев.

**Issue invariant:** Issue #990 требует, чтобы `01777` после редактирования и сохранения оставался `01777`, а не превращался в `1777`. PR #991 обнаруживает исходный scalar через `source`, сохраняет числовое значение и использует YAML 1.1 для вывода ведущего нуля.

- [x] **Step 1: Добавить падающие round-trip-тесты**

В `test/common/util-common.test.ts` добавить:

```ts
test("YAML comment copier preserves legacy octal mode", () => {
    const source = parseDocument(
        "services:\n  app:\n    volumes:\n      - type: tmpfs\n        target: /cache\n        tmpfs:\n          mode: 01777\n"
    );
    const target = parseDocument(source.toString());

    copyYAMLComments(target, source);

    assert.match(target.toString(), /mode: 01777/);
});
```

Добавить проверку, что после применения octal не меняется смысл строковых Compose-скаляров `yes`, `no`, `on`, `off`: итоговый документ обязан сохранить их как строки при повторном `parseDocument(...).toJS()`. Добавить тест обычного YAML без octal, чтобы существующее форматирование и комментарии не переключали схему без необходимости.

Run:

```bash
node --import tsx --test test/common/util-common.test.ts
```

Expected: тест `01777` сначала показывает потерю ведущего нуля на текущем коде.

- [x] **Step 2: Перенести обнаружение octal на типизированный `Scalar`**

В `common/util-common.ts` использовать уже импортированный `isScalar` либо добавить типизированный импорт `Scalar`. В `copyYAMLCommentsItems()` при совпадении исходного и целевого узлов проверить:

```ts
if (
    isScalar(item.value) &&
    isScalar(srcItem.value) &&
    typeof item.value.value === "number" &&
    typeof srcItem.value.source === "string" &&
    /^0[0-7]+$/.test(srcItem.value.source)
) {
    item.value.value = Number.parseInt(srcItem.value.source, 8);
    item.value.format = "OCT";
    hasLegacyOctal = true;
}
```

Изменить рекурсивную функцию так, чтобы она возвращала `boolean` и объединяла результат дочерних коллекций. В `copyYAMLComments()` вызвать `doc.setSchema("1.1")` только если найден хотя бы один legacy octal scalar. Не добавлять новое YAML-представление и не переписывать незатронутые scalar-значения вручную.

- [x] **Step 3: Проверить YAML 1.1 побочные эффекты**

Проверить в тестах одновременно:

- `mode: 01777` сериализуется с ведущим нулём;
- `environment: { ENABLED: yes }` после round-trip остаётся строкой `"yes"`, а не boolean;
- `restart: on-failure` остаётся строкой;
- обычный документ без octal не получает лишних кавычек из-за переключения схемы.

Если `yaml` сериализует строковые значения неоднозначно, зафиксировать ожидаемые кавычки в тесте: важен тип значения после повторного разбора, а не отсутствие кавычек.

- [x] **Step 4: Запустить проверки и зафиксировать результат**

Run:

```bash
npm run lint
npm run check-ts
node --import tsx --test test/common/util-common.test.ts
git diff --check
```

Expected: octal round-trip, comments, nested collections и Compose-строки проходят без `any`-ошибок сверх уже существующего локального участка YAML-кода.

- [x] **Step 5: Commit**

```bash
git add common/util-common.ts test/common/util-common.test.ts
git commit -m "fix: preserve octal compose values"
```

---

### Task 5: Финальная проверка и документация интеграции

**Files:**
- Modify: `README.md` only if the Docker integration test adds a new required local command
- Modify: `CONTRIBUTING.md` only if the test matrix needs a documented Docker prerequisite
- Read: `package.json`, `.github/workflows/ci.yml`, `test/backend/*.test.ts`, `test/common/*.test.ts`

**Interfaces:**
- Consumes: результаты Tasks 1–4 и существующие требования к Node.js/CI.
- Produces: воспроизводимое локальное и CI-подтверждение, что четыре issue закрыты без снижения покрытия.

- [x] **Step 1: Проверить связь каждого исправления с issue**

Проверить acceptance matrix:

| Issue | Проверяемое поведение |
|---|---|
| #994 | `../outside`, абсолютный путь, обратный слеш и symlink не читают и не удаляют внешний каталог; `disableAuth` не меняет результат проверки пути |
| #964 | изменение env-секции записывает `.env`; очистка существующего env очищает файл; пустой новый env не создаёт файл |
| #806 | `exited(0)` + `running` отображается как `RUNNING`; ненулевой exit и неизвестные состояния остаются `EXITED` |
| #990 | `tmpfs.mode: 01777` сохраняет текст и числовую octal-семантику; Compose-строки не становятся boolean |

- [x] **Step 2: Выполнить полный набор проверок**

Run:

```bash
node --version
npm run check
npm run build:frontend
npm audit --omit=dev --audit-level=high
npm run test:docker-integration
git diff --check
```

Expected: Node соответствует `22.23.2` или `24.19.0`, покрытие остаётся выше 70% для настроенных c8-метрик, TypeScript и ESLint проходят, Docker integration job завершается успешно, high-level audit vulnerabilities отсутствуют.

- [x] **Step 3: Проверить, что в тестах нет ложных заглушек**

Run:

```bash
rg -n "Terminal\.exec\s*=|spawn\s*=|mock|stub|sinon|jest\.spyOn" test extra
```

Expected: отсутствуют подмены, которые позволяют path traversal, `.env` или Docker status тесту завершиться успешно без выполнения проверяемой логики. Допустимы только реальные временные файлы, реальный `process.execPath` и реальный Docker Compose.

- [x] **Step 4: Зафиксировать итоговый diff и результаты**

Run:

```bash
git status --short
git diff --stat
git log --oneline -4
```

Expected: пять небольших тематических коммитов, отсутствие изменений в исходной рабочей копии этого репозитория и отчёт с результатами всех команд.

---

### Task 6: Добавить безопасное обновление Git → Docker Compose

**Files:**
- Create: `extra/update-dockge.ts`
- Create: `test/backend/update-dockge.test.ts`
- Modify: `package.json:8-16`
- Modify: `README.md:130-135`

**Interfaces:**
- Consumes: рабочая копия Compose-файла, локальная `backend/child-process.ts`, `compose.yaml` с образом `louislam/dockge:1`.
- Produces: локальный CLI `npm run update-docker` с режимами проверки и обновления без `down -v`, `git reset --hard` или `git clean`.

**Deployment invariant:** В тогдашнем корневом `compose.yaml` (удален: он ставил upstream-образ) данные подключены bind mount-ами `./data:/app/data` и `/opt/stacks:/opt/stacks`. Поэтому пересоздание контейнера не удаляет содержимое этих каталогов, но удаление файлов с хоста всё равно возможно отдельной командой. `git pull` не обновляет код внутри контейнера: текущий Compose использует опубликованный `image`, а не `build` из рабочей копии.

- [x] **Step 1: Определить безопасный набор команд и добавить тест построения аргументов**

В `extra/update-dockge.ts` экспортировать:

```ts
export interface UpdateCommand {
    command: string;
    args: readonly string[];
}

export function buildUpdateCommands(forceRecreate: boolean): readonly UpdateCommand[] {
    return [
        { command: "git", args: [ "pull", "--ff-only", "origin", "master" ] },
        { command: "docker", args: [ "compose", "config", "--quiet" ] },
        {
            command: "docker",
            args: [
                "compose", "up", "-d", "--pull", "always",
                ...(forceRecreate ? [ "--force-recreate" ] : []),
                "--wait", "--wait-timeout", "60",
            ],
        },
    ];
}
```

Добавить в `test/backend/update-dockge.test.ts` точные проверки аргументных массивов для обычного режима и `forceRecreate`. Тестировать построитель как чистую функцию; не подменять `child_process.spawn` и не запускать настоящий deploy из unit-теста.

- [x] **Step 2: Реализовать запуск только разрешённых команд**

Скрипт должен:

1. принять только `--dry-run` и `--force-recreate`;
2. перед `git pull` выполнить `git status --porcelain` и завершиться с ошибкой, если рабочая копия не чистая;
3. в режиме `--dry-run` вывести команды и не менять Git/Docker;
4. в обычном режиме последовательно выполнить команды через локальную `spawn()` с аргументным массивом;
5. завершиться с ненулевым кодом при ошибке любой команды;
6. после `docker compose up` сообщить, что health-check завершён через `--wait`.

Не добавлять Socket.IO-событие для запуска обновления из браузера. Такой механизм фактически даст пользователю удалённый `git pull` и управление Docker; запускать его можно только локально, через systemd timer, CI/CD или административный shell.

- [x] **Step 3: Зафиксировать правильную семантику пересоздания и хранения данных**

В README описать команды:

```bash
cd /opt/dockge
npm run update-docker -- --dry-run
npm run update-docker
```

Отдельно указать:

- `docker compose up` сам пересоздаёт контейнер при изменении образа/конфигурации и сохраняет подключённые volumes/bind mounts;
- `--force-recreate` принудительно пересоздаёт контейнер, но не удаляет подключённые данные;
- `--pull always` гарантирует проверку нового образа;
- `--wait --wait-timeout 60` не оставляет обновление в неопределённом состоянии;
- не использовать `docker compose down -v`, `docker volume prune`, `git reset --hard` и `git clean -fdx` в автоматическом сценарии;
- `./data` лучше вынести за пределы Git checkout, например `/var/lib/dockge/data`, чтобы даже ошибочный `git clean` не затронул базу.

Для публикации fork-кода не запускать бездумно `docker compose build`: текущий Compose использует registry image. Сначала CI должен собрать и опубликовать образ с проверенным тегом, после чего deploy делает `git pull` конфигурации и `docker compose up --pull always`.

- [x] **Step 4: Добавить npm-команду и dry-run-проверку в CI**

В `package.json` добавить:

```json
"update-docker": "tsx ./extra/update-dockge.ts"
```

В основной CI-матрице запускать только:

```bash
npm run update-docker -- --dry-run
```

Реальный `git pull` и deploy в CI не выполнять: для него нужны отдельные секреты, окружение и политика релиза.

- [x] **Step 5: Запустить проверку сценария**

Run:

```bash
npm run lint
npm run check-ts
npm run update-docker -- --dry-run
git diff --check
```

Expected: dry-run показывает `git pull --ff-only`, `docker compose config --quiet` и `docker compose up -d --pull always --wait --wait-timeout 60`; ни один процесс не запускается, а unit-тесты подтверждают отсутствие shell-инъекции.

- [x] **Step 6: Commit**

```bash
git add extra/update-dockge.ts test/backend/update-dockge.test.ts package.json README.md
git commit -m "feat: add safe git and compose update command"
```
