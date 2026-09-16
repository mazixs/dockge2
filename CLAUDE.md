# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`dockge2` - форк Dockge: самохостинговый менеджер стеков `compose.yaml`. Работа ведется в ветке `main`. Node 22.23.2 / 24.19.0.

## Команды

```bash
npm run dev            # backend 5001 + frontend 5000 (dev:backend / dev:frontend отдельно)
npm run check          # lint + check-ts + test - перед сдачей работы
npm run lint           # ESLint по **/*.{ts,vue}; npm run fmt - автофикс
npm run check-ts       # tsc --noEmit (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
npm run test           # c8 + node:test, порог покрытия 70%
npm run test:unit      # без покрытия
npm run test:docker-integration   # нужен живой Docker Compose
npm run test:e2e       # Playwright, реальный Chromium и контейнеры
npm run build:frontend # сборка в frontend-dist/

node --import tsx --test test/backend/util-stack.test.ts                       # один файл
node --import tsx --test --test-name-pattern "envsubst" test/common/util-common.test.ts  # один тест
```

## Где что живет

| Путь | Что там |
| --- | --- |
| `backend/dockge-server.ts` | точка сборки: Express, Socket.IO, регистрация хендлеров, 10-секундный крон |
| `backend/socket-handlers/` | события без агент-прокси: настройки, CRUD агентов, пользователи, `agent-proxy-socket-handler.ts` - роутер события `"agent"` |
| `backend/agent-socket-handlers/` | агент-совместимые события: стеки, git, терминалы, стабильность |
| `backend/stack.ts`, `stack-config.ts`, `stack-source.ts`, `stack-git.ts` | модель стека как директории, разрешение путей файлов, источники, git |
| `backend/auth.ts`, `auth-access.ts`, `agent-auth.ts` | Better Auth, сессии, `doubleCheckPassword`, доступ агентов |
| `backend/mcp-*.ts` | MCP-сервер, политика, ключи, делегированные операции (см. `docs/mcp.md`) |
| `backend/terminal.ts` | обертка node-pty, статический `terminalMap` |
| `backend/child-process.ts` | promise-обертка над spawn для docker / docker compose |
| `backend/database.ts`, `backend/migrations/` | Knex + SQLite: только пользователи, настройки, агенты |
| `backend/util-server.ts` | `DockgeSocket`, `checkLogin`, `callbackResult` / `callbackError` |
| `common/` | код, общий для фронта и бэка: `util-common.ts` (статусы, имена терминалов, envsubst), `compose-status.ts`, `compose-editor.ts`, `stack-files.ts` (allow-list имен файлов), `availability.ts`, `agent-socket.ts` |
| `frontend/src/mixins/socket.ts` | слой состояния: соединение, сессия, `stackList`, `emitAgent` |
| `frontend/src/pages/`, `components/`, `layouts/` | Vue 3 SFC на options API |
| `frontend/src/styles/tokens.scss` | токены дизайн-системы (light на `:root`, dark на `body.dark`); `vars.scss` дублирует их для легаси |
| `frontend/src/lang/en.json` | источник правды для строк, `ru.json` держим полным |
| `docs/design-system.md` | дизайн-система |
| `docs/design/` | текущие продуктовые аудиты и макеты |
| `docs/plans/2026-08-26-dockge2-master-plan.md` | мастер-журнал требований и решений, читать перед фичей |
| `docs/authentication.md`, `docs/mcp.md` | аутентификация и MCP |
| `test/backend`, `test/common`, `test/frontend` | юнит-тесты (реальные ФС и процессы), `test/helpers/database.ts` - `withDatabase()` |
| `test/docker/`, `test/e2e/`, `test/visual/` | интеграция с Docker, Playwright, визуальные проверки |
| `extra/` | скрипты: `reset-account.ts`, `update-dockge.ts`, `deploy-stack.ts` |

## Архитектура в двух словах

- **API - это Socket.IO**, а не REST: каждое событие с ack-колбэком `{ ok, msg?, msgi18n? }`. Хендлер сначала `checkLogin`, потом валидация каждого аргумента, потом `callbackResult` / `callbackError`.
- **Мульти-агент**: фронт зовет `emitAgent(endpoint, event, ...)`, сервер маршрутизирует локально, на все эндпоинты (`ALL_ENDPOINTS`) или в исходящее socket.io-client соединение из `AgentManager` (создается на каждый браузерный сокет). Новая фича со стеками или терминалами обязана быть агент-хендлером, иначе работает только локально.
- **Стеки - файлы, не строки БД**: директория в `DOCKGE_STACKS_DIR` (по умолчанию `/opt/stacks`). Статус собирается из одного `docker ps` и агрегируется fail-closed в `common/compose-status.ts`.
- **Правки compose сохраняют файл пользователя**: `analyseComposeSource` / `canEditStructurally` / `applyStructuredEdit` в `common/compose-editor.ts`; перезапись текста только по явному редактированию.
- **Секреты** - файлы с правами `0600`; наружу идут только метаданные, `revealSecret` / `saveSecret` / `deleteSecret` требуют `doubleCheckPassword`.
- **Аутентификация**: Better Auth смонтирован на `/api/auth/*` до парсеров тела; сессия в httpOnly-куке, сокет получает `userID` на хендшейке; аккаунт ровно один.

## Конвенции

- 4 пробела (2 в YAML), LF, двойные кавычки, точки с запятой, `array-bracket-spacing: always`, JSDoc на неочевидных методах. `camelCase` в TS, `snake_case` для колонок SQLite, `kebab-case` для CSS.
- Настройки - в UI (таблица `setting`), env-переменные только для старта: `DOCKGE_STACKS_DIR`, `DOCKGE_PORT`, `DOCKGE_DATA_DIR`, `DOCKGE_SSL_*`, `DOCKGE_ENABLE_CONSOLE`, `DOCKGE_TRUSTED_ORIGINS`, `DOCKGE_TRUST_PROXY`, `DOCKGE_SECURE_COOKIES`, `DOCKGE_AUTH_SECRET`.
- Зависимости бэкенда - в `dependencies`, фронтенда и тулинга - в `devDependencies`.
- Никаких HTML в строках локализации - разметка через `<i18n-t>`.
- Никогда не добавлять событие, дающее браузеру запуск произвольных git/shell/Docker команд; имена файлов стека - только безопасные относительные (без `..`, абсолютных путей и симлинков).
