# План: масштабируемый интерфейс, обзор Docker и выпуск Dockge 2

> **Статус на 2026-09-16: чекбоксы этого файла не ведутся, за состоянием идти в мастер-план.**
> Здесь 76 незакрытых пунктов и ни одного закрытого, хотя четыре задачи из девяти сделаны. Итог по
> каждой задаче с причиной, почему остальные открыты, - в чеклисте
> `docs/plans/2026-08-26-dockge2-master-plan.md` (пункты "Выполнить там Task 1-9"). Коротко:
> сделаны Task 1 (контракт общего обзора), Task 2 (dashboard без выбранного агента), Task 4
> (история доступности и retention) и Task 8 (бренд, версия 2.0.0, свой namespace образов).
> Открыты Task 3 (постраничный вывод и экран связей сервисов), Task 5 (контейнеры вне
> `stacksDir`), Task 6 (собственный контейнер панели), Task 7 (corpus-аудит `docker run`) и
> Task 9 (проверка на 500 и 2000 контейнерах). Этот файл остается декомпозицией и критериями
> приемки, а не трекером.
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать интерфейс удобным для большого числа агентов, стеков и контейнеров, добавить измеримый обзор состояния Docker, безопасный режим обнаружения контейнеров вне `stacksDir` и подготовить публичный выпуск под версией 2.x.

**Architecture:** Сначала выделить общий типизированный снимок состояния, который собирается из агентских статусов и уже разработанной per-service/per-instance модели Compose. Dashboard, список стеков и карточка агента используют один снимок, а исторические показатели считаются сервером по наблюдениям с известным интервалом. Обзор всех контейнеров отделяется от управления Compose-стеками: обнаружение может быть read-only, а опасные действия требуют отдельной capability.

**Tech Stack:** Vue 3/Vite, Bootstrap Vue Next и существующие SCSS-токены; Express/Socket.IO; Docker CLI/Compose CLI; SQLite/Knex для истории наблюдений; TypeScript strict; Node.js 24.19.0 LTS с совместимостью Node.js 22.23.2 LTS; Playwright для реального браузерного сценария; c8.

**Spec:** `docs/plans/2026-08-26-dockge2-master-plan.md` — главный журнал требований и решений.

## Global Constraints

- IC означает `Impact × Confidence`: Impact и Confidence оцениваются от 1 до 5, итоговый балл — произведение; трудоёмкость `S/M/L/XL` хранится отдельно.
- Новые продуктовые изменения из этого плана относятся к P2/P3 и не должны задерживать исправления безопасности, статусов, Compose-файлов, строгой типизации и покрытия.
- Текущая модель "управляемые Dockge Compose-стекы" сохраняется и не меняется молча.
- Режим просмотра всех контейнеров по умолчанию рекомендуется оставить выключенным для существующих установок; после явного включения он даёт read-only inventory. Управление, удаление, `exec`, `kill` и изменение контейнеров вне управляемого стека требуют отдельной capability и по умолчанию выключены.
- Процент доступности показывается только с временным окном, числом наблюдений и количеством неизвестных наблюдений; при недостатке истории показывать `недостаточно данных`, а не `100%`.
- `UNKNOWN` и недоступность Docker не считаются здоровым состоянием и не маскируются под `inactive`.
- Все метрики привязываются к `endpoint` и идентификатору контейнера/стека; одинаковые имена на разных агентах не объединяются.
- Содержимое env/secret не попадает в метрики, логи, карточки, поисковый индекс и обычные ответы API.
- Для публичного бренда использовать `Dockge 2`, но не делать без карты миграции глобальную замену технических идентификаторов `dockge`, `DOCKGE_*`, API-событий, upstream URL и Docker-образов.
- Версии выпускаются по SemVer: первая стабильная версия — `2.0.0`, исправление — `2.0.1`, предварительная версия — `2.0.0-rc.1`; форма `2.0.1.1` не используется, четвёртая координата при необходимости оформляется как build metadata `2.0.1+build.1`.
- Новая библиотека добавляется только после измерения: текущий Bootstrap/SCSS и нативные возможности Vue используются первыми; виртуализация списка допускается только при подтверждённой проблеме производительности на тестовом наборe из 500+ элементов.
- Не использовать фальшивые данные, заглушки, подмену Docker API или Clipboard API ради зелёного теста.

## IC-приоритизация

| Направление | Impact | Confidence | IC | Объём | Приоритет | Причина |
|---|---:|---:|---:|---|---|---|
| Dashboard: состояние агентов, стеков, контейнеров и доступность | 5 | 5 | 25 | M/L | P2 | Улучшает ежедневную диагностику и использует уже имеющиеся данные. |
| Компактный список при большом количестве стеков/контейнеров | 5 | 4 | 20 | L | P2 | Текущая плоская выдача и скрытые фильтры плохо масштабируются. |
| Аудит `docker run` → Compose и окно результата | 4 | 4 | 16 | M | P2 | Текущий путь рабочий, но удаляет первую строку и не показывает ограничения преобразования. |
| Самоконтроль контейнера Dockge 2 и безопасная консоль | 4 | 4 | 16 | M | P2 | Control plane имеет Docker socket и требует понятного состояния/границ риска. |
| Обзор контейнеров во всех папках сервера | 5 | 3 | 15 | L/XL | P2 | Полезно для эксплуатации, но расширяет область видимости и управления. Нужен security gate. |
| Связи сервисов: `depends_on`, networks, ports, volumes, secrets | 4 | 3 | 12 | L | P3 | Уменьшает сложность больших стеков, но не должно автоматически менять YAML. |
| Версионирование и release-артефакты 2.x | 4 | 5 | 20 | S/M | P2 | Защищает выпуск от случайного тега `1.x`/`:1` и рассинхрона пакета, образа и UI. |
| Внешнее имя, иконка и визуальная полировка | 2 | 4 | 8 | S/M | P3 | Важно для второй версии, но не исправляет эксплуатационные риски. |

## Зависимости задач

1. Модель статусов из `2026-08-26-console-status-compose-git.md`, задача 3, является входом для Dashboard и метрик.
2. Dashboard нельзя считать доступностью только по текущему `stackList`: для процента нужна история наблюдений и понятный знаменатель.
3. Глобальный inventory сначала должен получить security policy и типы источника контейнера; только после этого можно добавлять действия.
4. Перевод имени и тегов 2.x выполняется после определения собственного Docker image namespace, чтобы не перепутать форк с `louislam/dockge`.

## Task 0: UX baseline и выбор направления дизайна

**Files:**
- Create: `docs/superpowers/specs/2026-08-26-dockge2-product-design.md` — утверждённое направление, дизайн-токены, информационная архитектура и ограничения.
- Modify: `frontend/src/pages/DashboardHome.vue`, `frontend/src/pages/Dashboard.vue`, `frontend/src/components/StackList.vue`, `frontend/src/components/StackListItem.vue`, `frontend/src/components/DockerStat.vue` — использовать как фактический baseline, не переписывать до утверждения brief.
- Modify: `frontend/src/styles/main.scss`, `frontend/src/styles/vars.scss` — инвентаризация текущих цветов, радиусов, теней, типографики и dark theme.
- Create: `test/e2e/product-baseline.spec.ts` — проверка доступных состояний и отсутствия регрессии при подготовке.

Текущий визуальный снимок в чистой установке показал экран создания администратора с брендом `Dockge`; main dashboard не удалось открыть без создания локальной учётной записи. В коде дополнительно обнаружена ошибка, блокирующая стабильный UX-стенд: `frontend/src/mixins/lang.ts` при Vue I18n 11 обращается к `i18n.global.locale.value`, хотя в legacy mode `locale` является строкой, из-за чего creation hook завершается с `TypeError`.

До реализации сравнить три направления и выбрать одно в design spec:

1. **Operations control room** — компактный тёмный/светлый режим, плотная таблица, фиксированные фильтры, alert-first сортировка. Рекомендован для сотен контейнеров.
2. **Overview-first** — спокойная главная страница с metric cards, лентой проблем и переходом в подробности; ниже плотная таблица. Рекомендован для ежедневного контроля.
3. **Resource explorer** — дерево endpoint → stack → service и split panel с отношениями, health и действиями; лучше объясняет связи, но требует больше навигации.

Рекомендованный гибрид: направление 2 для главного экрана, направление 1 для больших списков и направление 3 для панели связей. Это рекомендация для brief, а не разрешение сразу менять код.

- [ ] **Step 1: Зафиксировать baseline.** Записать текущий layout, компоненты, токены, доступные responsive breakpoints, loading/empty/error states и фактические ограничения чистого старта.
- [ ] **Step 2: Исправить блокирующий locale state.** Выбрать один режим Vue I18n 11, привести `frontend/src/mixins/lang.ts` и `frontend/src/i18n.ts` к согласованному API, покрыть смену языка реальным компонентным/браузерным тестом.
- [ ] **Step 3: Согласовать visual direction.** В design spec записать выбранный вариант, а не оставлять три конкурирующих набора токенов в коде; не добавлять новый UI-framework.
- [ ] **Step 4: Проверить baseline-тест.** Запустить `npm run build:frontend` и `npm run lint`; при ошибке не считать направление готовым к реализации.

**Acceptance:** команда понимает, какой экран и для какого объёма контейнеров строится; текущая чистая установка запускается без ошибки locale, а визуальные изменения имеют один утверждённый source of truth.

## Task 1: Контракт глобального обзора и базовая IC-метрика

**Files:**
- Create: `common/types/overview.ts` — типы снимка, агента, стека, контейнера и временного ряда.
- Create: `common/overview.ts` — чистая агрегация и вычисление текущих счётчиков.
- Modify: `frontend/src/mixins/socket.ts` — типизированное хранение snapshot по endpoint.
- Modify: `backend/dockge-server.ts` — отправка snapshot и сбор наблюдений.
- Modify: `backend/agent-socket-handlers/docker-socket-handler.ts` — endpoint для явного запроса overview.
- Create: `test/common/overview.test.ts` — детерминированная агрегация без Docker-заглушки.

**Interfaces:**

```ts
type OverviewStatus = "RUNNING" | "ATTENTION" | "EXITED" | "CREATED" | "UNKNOWN";
type AgentAvailability = "online" | "offline" | "connecting" | "unknown";

interface AgentOverview {
    endpoint: string;
    displayName: string;
    availability: AgentAvailability;
    lastSeenAt: string | null;
    stackCounts: Record<OverviewStatus, number>;
    containerCounts: Record<OverviewStatus, number>;
}

interface AvailabilityMetric {
    window: "24h" | "7d" | "30d";
    percentage: number | null;
    observedSamples: number;
    expectedSamples: number;
    unknownSamples: number;
    calculatedAt: string;
}

interface GlobalOverviewSnapshot {
    generatedAt: string;
    scope: "managed-only" | "all-readonly";
    agents: AgentOverview[];
    stacks: Record<OverviewStatus, number>;
    containers: Record<OverviewStatus, number>;
    availability: AvailabilityMetric;
}
```

- [ ] **Step 1: Зафиксировать входной контракт текущих socket-событий.** Сопоставить `agentStatusList`, `agentList`, `stackList`, `allAgentStackList` и per-service status с полями `AgentOverview`; неизвестные значения сохранить как `unknown`.
- [ ] **Step 2: Написать падающие тесты агрегации.** Проверить онлайн/офлайн/connecting, пустой список, одинаковые имена стеков на разных endpoint, смешанные `RUNNING`/`ATTENTION`/`UNKNOWN` и отсутствие двойного счёта локального endpoint.
- [ ] **Step 3: Реализовать чистую агрегацию.** Не читать DOM, localStorage или Docker внутри `common/overview.ts`; на вход принимать нормализованные записи и возвращать `GlobalOverviewSnapshot`.
- [ ] **Step 4: Добавить серверный snapshot endpoint/event.** Отправлять один типизированный снимок вместо разрозненного вычисления трёх чисел в `DashboardHome.vue`; ответ не должен содержать env/secret. До Task 5 scope равен `managed-only`, после включения read-only inventory snapshot дополнительно включает внешние контейнеры.
- [ ] **Step 5: Проверить unit-набор.** Выполнить `node --import tsx --test test/common/overview.test.ts` и убедиться, что неизвестное состояние не даёт положительного счётчика доступности.

**Acceptance:** один снимок даёт согласованные числа агентов, стеков и контейнеров для любой комбинации endpoint; данные с одинаковым именем, но разных агентов не теряются.

## Task 2: Dashboard без выбранного агента

**Files:**
- Modify: `frontend/src/pages/DashboardHome.vue` — убрать локальный пересчёт `activeNum/inactiveNum/exitedNum`, подключить `GlobalOverviewSnapshot`.
- Modify: `frontend/src/pages/Dashboard.vue` — сохранить main-area layout и корректно передать состояние выбранного endpoint.
- Create: `frontend/src/components/OverviewMetricCard.vue` — доступная карточка числа, состояния, времени и tooltip.
- Create: `frontend/src/components/AvailabilityCard.vue` — процент, окно, sample count и unknown count.
- Create: `frontend/src/components/AgentOverviewTable.vue` — активные/остановленные/неизвестные агенты и переход к агенту.
- Modify: `frontend/src/i18n.ts`, `frontend/src/lang/en.json`, `frontend/src/lang/ru.json` — тексты и accessible labels.
- Modify: `frontend/src/styles/main.scss`, `frontend/src/styles/vars.scss` — сетка, контраст, компактный режим и responsive rules.
- Create: `test/e2e/dashboard-overview.spec.ts` — реальный браузерный сценарий.

**Interfaces:**

```ts
interface OverviewMetricCardProps {
    label: string;
    value: number | string;
    status: "positive" | "warning" | "danger" | "neutral";
    detail: string;
}
```

- [ ] **Step 1: Описать состояния main area.** При отсутствии выбранного агента показывать global overview; при выборе агента показывать тот же набор карточек в scope endpoint с явной подписью области и режима `managed-only`/`all-readonly`.
- [ ] **Step 2: Разместить первичные показатели.** В первом ряду показать `агенты online`, `агенты offline`, `агенты attention/unknown`, `стеков running`, `стеков attention`, `контейнеров attention`; не смешивать agent count со stack count.
- [ ] **Step 3: Добавить доступность без ложной точности.** Показать процент за 24 часа по умолчанию, переключатели 7/30 дней, время последнего наблюдения и `unknownSamples`; при нулевой истории — `недостаточно данных`.
- [ ] **Step 4: Добавить действие из метрики.** Клик по карточке открывает соответствующий фильтр StackList с query-параметром, а "проблемные" элементы ведут к конкретному endpoint/стеку.
- [ ] **Step 5: Проверить responsive/accessibility.** Проверить keyboard focus, `aria-live` только для изменения сводки, не использовать цвет без текста/иконки, увеличить цели на touch и проверить zoom 200%.
- [ ] **Step 6: Выполнить Playwright-сценарий.** На реальном приложении проверить main area без выбора агента, числа, переход по проблемному статусу и stale/unknown message.

**Acceptance:** главная область отвечает на три вопроса без открытия стека: сколько агентов доступно, сколько объектов требуют внимания и насколько наблюдаемая инфраструктура стабильна; каждое число имеет scope и время обновления.

## Task 3: Масштабируемый список и связи сервисов

**Files:**
- Modify: `frontend/src/components/StackList.vue` — иерархия endpoint → stack → service/instance, фильтры и пагинация.
- Modify: `frontend/src/components/StackListItem.vue` — компактная строка с endpoint, статусом, проблемами и числом экземпляров.
- Modify: `frontend/src/components/Container.vue` — таблица экземпляров, bulk-safe actions и подробности.
- Create: `frontend/src/components/StackFilters.vue` — статус, endpoint, lifecycle, health, search и сохранение query.
- Create: `frontend/src/components/ServiceRelations.vue` — связи `depends_on`, networks, ports, volumes и secrets в read-only виде.
- Create: `frontend/src/components/ContainerTable.vue` — таблица с сортировкой и постраничным DOM.
- Modify: `frontend/src/pages/Compose.vue` — вкладка "Связи" и переход к YAML-узлу без автоматической записи.
- Modify: `frontend/src/styles/main.scss`, `frontend/src/styles/localization.scss` — плотность, sticky headers и mobile layout.
- Create: `test/unit/stack-list-query.test.ts`, `test/e2e/large-stack-list.spec.ts`, `test/e2e/service-relations.spec.ts`.

- [ ] **Step 1: Сформировать модель строки.** Использовать ключ `endpoint + stackName + serviceName + containerId`; индекс массива не является ключом, чтобы обновление списка не переносило действия на другой контейнер.
- [ ] **Step 2: Включить нынешние отключённые фильтры.** Реализовать фильтр по статусу, endpoint, сервису, образу, lifecycle и тексту; хранить фильтры в URL, чтобы ссылку на проблемный набор можно было передать другому оператору.
- [ ] **Step 3: Сделать список компактным.** По умолчанию свернуть второстепенные группы, показывать число сервисов/экземпляров и проблемный счётчик; постранично выводить до 50 строк, чтобы не создавать тысячи DOM-узлов.
- [ ] **Step 4: Добавить безопасные массовые действия.** Дать start/stop/restart только для выбранных управляемых Compose-сервисов, показать предварительный список и результат по каждому; внешние контейнеры не попадать в bulk action автоматически.
- [ ] **Step 5: Добавить панель связей.** Читать фактические `depends_on`, network membership, published ports, volumes и Compose secrets; не рисовать связь по совпадению имени и не менять YAML при открытии панели.
- [ ] **Step 6: Проверить производительность.** Сгенерировать 500 и 2 000 реальных JSON-строк статусов, измерить время фильтрации/рендера и память. При превышении согласованного порога 200 ms для первой отрисовки 500 строк добавить только после отдельного аудита `@tanstack/vue-virtual`; иначе оставить пагинацию без новой зависимости.
- [ ] **Step 7: Выполнить браузерные проверки.** Проверить поиск, фильтр по `ATTENTION`, раскрытие сервисов, сохранение query, keyboard navigation, мобильный экран и отсутствие действия на read-only external container.

**Acceptance:** 500+ контейнеров остаются обозримыми; оператор видит, почему сервис связан с другим, но открытие отношений не меняет Compose-файл и не расширяет права.

## Task 4: История доступности и стабильности

**Files:**
- Create: `backend/metrics/availability.ts` — запись наблюдений, rollup и расчёт процента.
- Create: `backend/migrations/2026-08-26-overview-metrics.ts` — таблица агрегированных наблюдений SQLite.
- Modify: `backend/dockge-server.ts` — планировщик опроса, TTL и публикация метрик.
- Modify: `backend/agent-manager.ts` — фиксировать online/offline/unknown наблюдение с endpoint.
- Modify: `backend/agent-socket-handlers/docker-socket-handler.ts` — выдавать агрегаты по scope и окну.
- Modify: `common/types/overview.ts` — `AvailabilityMetric`, причины unknown и sample metadata.
- Create: `test/backend/availability-metrics.test.ts`, `test/backend/metrics-migration.test.ts`.

**Interfaces:**

```ts
interface RuntimeObservation {
    endpoint: string;
    scopeType: "agent" | "stack";
    scopeKey: string;
    observedAt: string;
    status: "RUNNING" | "ATTENTION" | "EXITED" | "CREATED" | "UNKNOWN";
    expected: boolean;
}

function calculateAvailability(
    observations: readonly RuntimeObservation[],
    window: "24h" | "7d" | "30d",
    now: Date,
): AvailabilityMetric;
```

- [ ] **Step 1: Определить знаменатель.** Для агента ожидаемым является каждый плановый опрос; для стека ожидаемыми являются только известные долгоживущие сервисы. One-shot worker, неактивный профиль и `UNKNOWN` не превращать в успешное наблюдение.
- [ ] **Step 2: Написать тесты расчёта.** Проверить 100% только для всех известных `RUNNING`, снижение при `ATTENTION/EXITED`, нулевой результат при отсутствии samples, отдельный счётчик unknown и границы 24h/7d/30d.
- [ ] **Step 3: Добавить миграцию и TTL.** Хранить агрегированное наблюдение на endpoint/stack с датой, статусными счётчиками и количеством samples; удалять записи старше 30 дней отдельным ограниченным запросом.
- [ ] **Step 4: Подключить плановый сбор.** Собирать не чаще одного раза в 60 секунд и не блокировать socket-ответы; при ошибке сохранять `UNKNOWN`, но не увеличивать running samples.
- [ ] **Step 5: Опубликовать метрики.** Возвращать процент, окно, samples, unknown и `calculatedAt`; секреты, командные строки и пути env-файлов исключить.
- [ ] **Step 6: Проверить перезапуск сервера.** Реальный временный SQLite-файл должен сохранить историю после закрытия/повторного открытия Database; тест не использует in-memory подмену вместо миграции.

**Acceptance:** процент доступности объясним, воспроизводим и не заявляет стабильность при отсутствии данных; при сбое агента это видно как unknown/attention.

## Task 5: Безопасный inventory контейнеров на всём сервере

**Files:**
- Create: `common/types/container-inventory.ts` — `ContainerSource`, режимы scope и capability names.
- Create: `backend/docker-inventory.ts` — `docker ps --all --format json`, inspect выбранного контейнера и нормализация labels.
- Modify: `backend/dockge-server.ts` — периодическое обновление inventory с ограничением частоты.
- Modify: `backend/settings.ts` — `globalContainerInventoryEnabled` и `globalContainerControlEnabled` с безопасными значениями по умолчанию.
- Modify: `backend/agent-socket-handlers/docker-socket-handler.ts` — read-only inventory и проверка capability для действий.
- Modify: `frontend/src/pages/Settings.vue`, `frontend/src/components/settings/General.vue` — два явно подписанных переключателя с предупреждением.
- Create: `frontend/src/components/GlobalContainerList.vue` — external/standalone containers и источник обнаружения.
- Modify: `frontend/src/components/StackList.vue`, `frontend/src/components/StackListItem.vue` — объединение без коллизий по endpoint/container ID.
- Create: `test/backend/docker-inventory.test.ts`, `test/integration/global-container-scope.test.ts`, `test/e2e/global-container-scope.spec.ts`.

**Interfaces:**

```ts
type ContainerSource =
    | { kind: "managed-compose"; stackName: string; serviceName: string }
    | { kind: "external-compose"; projectName: string; configFiles: string[] }
    | { kind: "standalone" }
    | { kind: "unknown"; reason: string };

type ContainerScopeMode = "managed-only" | "all-readonly" | "all-control";

interface InventoryContainer {
    endpoint: string;
    id: string;
    name: string;
    image: string;
    state: string;
    source: ContainerSource;
    canRead: boolean;
    canControl: boolean;
}
```

- [ ] **Step 1: Определить источник контейнера.** Для Compose использовать системные labels `com.docker.compose.project`, `service`, `project.working_dir` и `project.config_files`, если Docker их возвращает; не считать пользовательское имя доказательством принадлежности к стеку.
- [ ] **Step 2: Написать тесты нормализации.** Проверить managed Compose из `stacksDir`, Compose в другой папке, standalone container, orphan, неизвестный/повреждённый label и одинаковые container names на двух endpoint.
- [ ] **Step 3: Реализовать read-only inventory.** Выполнять `docker ps --all --format json` аргументно, отображать источник и last seen, а `docker inspect` запускать только при открытии подробностей выбранного контейнера.
- [ ] **Step 4: Добавить scope settings.** Сохранить обратную совместимость: текущий control scope — managed-only; `all-readonly` включается отдельным параметром с описанием, что будут видны имена/образы контейнеров вне `stacksDir`.
- [ ] **Step 5: Разделить права.** `globalContainerControlEnabled` не включать вместе с inventory автоматически; start/stop/restart/exec/delete требуют capability, проверку user/agent endpoint и явного подтверждения.
- [ ] **Step 6: Обработать внешние Compose-файлы.** Если `config_files` недоступен внутри контейнера Dockge 2 или путь не разрешён, показывать контейнер как external read-only; не пытаться угадывать Compose-проект по имени.
- [ ] **Step 7: Проверить реальным Docker.** Создать Compose-проект во временной папке за пределами `stacksDir`, убедиться, что он обнаруживается в `all-readonly`, но не получает control actions без отдельного разрешения; проверить отсутствие доступа к env/secret content.

**Acceptance:** Dockge 2 может показать контейнеры из любых папок, но не раскрывает и не управляет ими молча; разрешение на просмотр и разрешение на изменение независимы.

## Task 6: Самоконтроль контейнера Dockge 2 и консоль control plane

**Files:**
- Modify: `compose.yaml` — проверить restart policy, healthcheck, mounts, image tag/digest и роль control plane.
- Modify: `docker/Base.Dockerfile`, `docker/Dockerfile` — проверить пользователя процесса, Docker CLI/Compose CLI, dumb-init, capabilities и минимальность образа.
- Modify: `frontend/src/pages/Console.vue` — понятное состояние отключённой консоли, причина риска и capability check.
- Modify: `frontend/src/components/Container.vue`, `frontend/src/components/GlobalContainerList.vue` — badge `control plane`, запрет опасного self-action и отдельное подтверждение restart.
- Modify: `backend/terminal.ts`, `backend/agent-socket-handlers/terminal-socket-handler.ts` — сохранить default-off и применить отдельную capability к основной консоли.
- Create: `backend/control-plane.ts` — self-detection, health, image, mounts и безопасные операции restart/logs.
- Modify: `backend/dockge-server.ts` — отправка control-plane metadata без секретов.
- Create: `test/integration/control-plane.test.ts`, `test/e2e/control-plane.spec.ts`.

- [ ] **Step 1: Снять baseline self-container.** На реальном Compose-стенде зафиксировать image digest, user, mounts, `/var/run/docker.sock`, restart policy, health status, uptime, restart count и доступный Docker Compose CLI.
- [ ] **Step 2: Определить self identity.** Использовать безопасно внедрённый role label/known Compose project и container ID; не считать совпадение имени достаточным, потому что пользователь может назвать другой контейнер `dockge`.
- [ ] **Step 3: Разделить self actions.** Read-only card показывает health/image/mounts/last restart; restart разрешён с предупреждением о краткой потере UI; remove/down/volume deletion из общего списка запрещены.
- [ ] **Step 4: Оставить основную консоль default-off.** При включении `DOCKGE_ENABLE_CONSOLE=true` показать, что доступ фактически даёт контроль над Docker host; проверять auth capability и не предлагать включить переменную из браузера.
- [ ] **Step 5: Проверить сохранность данных.** Пересоздать self-container через реальный `docker compose up -d --force-recreate` и проверить контрольный файл в bind mount `/app/data`; отдельно проверить, что стек не использует `down -v`.
- [ ] **Step 6: Проверить недоступность/ошибки.** При Docker socket error, неразрешённом self action или stale metadata показывать `UNKNOWN/ATTENTION`, а не успешное состояние.

**Acceptance:** control plane наблюдаем и управляем в ограниченном смысле, но обычная карточка контейнера не может случайно удалить сам Dockge 2 или его данные; основная console остаётся осознанно включаемой.

## Task 7: Аудит `docker run` → Compose и размещение конвертера

**Files:**
- Create: `common/types/compose-conversion.ts` — `ConversionResult`, warnings, source command fingerprint и validation state.
- Modify: `backend/socket-handlers/main-socket-handler.ts` — безопасная обёртка `composerize` с лимитом размера и нормальным разбором результата.
- Modify: `backend/types/composerize.d.ts` — точная сигнатура фактического API `composerize`.
- Modify: `frontend/src/pages/DashboardHome.vue` — компактный вход конвертера и переход в preview.
- Modify: `frontend/src/pages/Compose.vue` — preview/generated source, warnings, copy/download и явное сохранение.
- Create: `test/backend/compose-conversion.test.ts`, `test/e2e/compose-conversion.spec.ts`, `test/fixtures/docker-run/*.txt`.

Текущую зависимость `composerize@1.7.6` не заменять автоматически: по текущему npm-пакету она публикуется и предназначена для преобразования `docker run` в Compose, но её результат должен быть проверен нашим контрактом. Официальный Compose CLI умеет валидировать/рендерить Compose-модель, но не является заменой этого входного преобразователя ([CLI](https://docs.docker.com/reference/cli/docker/compose/)).

- [ ] **Step 1: Составить corpus команд.** Добавить фикстуры для image/name, ports, bind/named volumes, env/env-file, restart, user, network, healthcheck, read-only, capabilities, devices/GPU, labels, `--init`, `--entrypoint`, command/args и неизвестных флагов.
- [ ] **Step 2: Зафиксировать семантику.** Для каждой команды определить поля, которые обязаны сохраниться, поля, которые требуют warning, и поля, которые нельзя добавлять автоматически. Default Compose network не добавлять в YAML только потому, что контейнер запускается в Compose.
- [ ] **Step 3: Проверить реальный composerize.** Вызвать установленную библиотеку на corpus, распарсить YAML и прогнать `docker compose config --quiet` в изолированном временном каталоге без запуска контейнеров.
- [ ] **Step 4: Исправить потерю первой строки.** Не удалять первую строку через `split().slice(1)`; удалять только известный генераторный top-level `name`, если он действительно присутствует, и сохранять все остальные поля.
- [ ] **Step 5: Добавить предупреждения.** Неподдержанный или неоднозначный флаг показывать пользователю; не молча отбрасывать его и не подменять небезопасным значением.
- [ ] **Step 6: Перестроить окно.** На главном экране оставить короткое поле и кнопку, после запуска открыть Compose preview с generated YAML, warnings, validation result и кнопкой "Открыть для редактирования"; сохранение всегда отдельное действие.
- [ ] **Step 7: Проверить безопасность.** Входной текст не исполняется, не логируется и не попадает в shell command; ограничить размер запроса и применить существующую auth/rate-limit policy.

**Acceptance:** конвертер сохраняет проверяемую семантику команды, явно сообщает ограничения и не ухудшает Compose YAML ради "красивого" результата; текущая библиотека остаётся только после corpus-аудита.

## Task 8: Бренд, иконка, репозиторий и SemVer 2.x

**Files:**
- Modify: `package.json`, `package-lock.json` — version `2.0.0`/pre-release policy и единый product name constant.
- Modify: `extra/update-version.ts` — strict SemVer parser, запрет major `< 2`, проверка tag/image consistency.
- Modify: `extra/mark-as-nightly.ts` — nightly versions based on major 2 without modifying unrelated source text.
- Modify: `frontend/src/main.ts`, `frontend/src/i18n.ts`, `frontend/src/lang/en.json`, `frontend/src/lang/ru.json` — visible `Dockge 2` name and compatibility copy.
- Replace: `frontend/public/icon.svg`, `frontend/public/favicon.ico`, `frontend/public/apple-touch-icon.png`, `frontend/public/icon-192x192.png`, `frontend/public/icon-512x512.png` — approved icon source in all sizes.
- Modify: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/PULL_REQUEST_TEMPLATE.md` — repository/docs links and release terminology.
- Modify: `compose.yaml`, `docker/Base.Dockerfile`, `docker/Dockerfile` — own image namespace/tag policy and control-plane labels.
- Modify: `.github/workflows/ci.yml`, `.github/workflows/nightly-release.yml` — version/image metadata and tags.
- Create: `test/backend/version-policy.test.ts`, `test/e2e/branding.spec.ts`.

- [ ] **Step 1: Разрешить имя.** Зафиксировать публичное отображаемое имя `Dockge 2`, а технические identifiers `dockge`/`DOCKGE_*` и upstream API временно сохранить в compatibility layer; не менять URL/image namespace без точного адреса собственного репозитория/registry.
- [ ] **Step 2: Ввести единый источник версии.** `package.json.version`, frontend build constant, release tag и Docker image version tag должны происходить из одного SemVer значения; версия `1.x` и Docker tag `:1` для новых выпусков запрещены.
- [ ] **Step 3: Реализовать допустимые формы.** Принимать `2.0.0`, `2.0.1`, `2.0.0-rc.1`, `2.0.0+build.1`; отклонять `2`, `2.1` и `2.0.1.1` как публичные release values.
- [ ] **Step 4: Обновить release pipeline.** Стабильные теги — `v2.x.y`, pre-release — `v2.x.y-rc.n`; Docker получает version tag и согласованные major aliases только для собственного image namespace, а не `louislam/dockge:1`.
- [ ] **Step 5: Обновить видимый бренд.** Заменить title, favicon, меню, README и справочные подписи на `Dockge 2`; оставить явную compatibility note там, где старый `Dockge` нужен для миграции, API или образа.
- [ ] **Step 6: Проверить иконку и UI.** Использовать один утверждённый исходник, проверить светлую/тёмную тему, favicon/PWA-размеры, контраст и отсутствие растянутых вариантов; не создавать случайный SVG в коде без брендового решения.
- [ ] **Step 7: Проверить release guard.** Тестами подтвердить отказ версии major 1, отсутствие `:1` в release workflow и корректные nightly tags; не запускать commit/tag во время unit-теста.

**Acceptance:** первая публичная версия форка начинается с `2.0.0`, пользователь видит `Dockge 2`, а техническая совместимость не ломается из-за поспешной глобальной замены строк.

## Task 9: Итоговая UX/accessibility/performance-проверка

**Files:**
- Modify: `frontend/src/pages/DashboardHome.vue`, `frontend/src/components/StackList.vue`, `frontend/src/components/GlobalContainerList.vue`, `frontend/src/components/ServiceRelations.vue` — финальные states и keyboard flow.
- Modify: `frontend/src/styles/main.scss`, `frontend/src/styles/vars.scss` — tokens, focus ring, contrast and responsive breakpoints.
- Modify: `frontend/src/mixins/lang.ts`, `frontend/src/i18n.ts` — согласованный Vue I18n 11 mode без `locale.value` ошибки.
- Create: `test/e2e/dashboard-accessibility.spec.ts`, `test/e2e/dashboard-responsive.spec.ts`.
- Modify: `docs/testing.md` и `docs/deployment.md` — ручные сценарии и ограничения метрик/scope.

- [ ] **Step 1: Проверить states.** Зафиксировать loading, empty, stale, Docker unavailable, permission denied, `ATTENTION`, `UNKNOWN`, zero-history и 2 000-row states.
- [ ] **Step 2: Проверить навигацию.** Пройти dashboard → проблемный агент → stack → service → container → relation; каждое действие доступно клавиатурой и имеет понятный focus.
- [ ] **Step 3: Проверить responsive.** Выполнить Chromium-проверки ширины 375, 768 и 1440 px, zoom 200%, dark theme и длинные имена endpoint/service.
- [ ] **Step 4: Проверить performance budget.** Снять runtime timings для 500/2 000 контейнеров и убедиться, что обновление snapshot не перерисовывает весь список и не создаёт бесконечные socket listeners.
- [ ] **Step 5: Провести полный прогон.** Запустить `npm run lint`, `npm run check-ts`, `npm run test`, `npm run coverage`, Docker integration и Playwright; сохранить отчёт с фактическим покрытием выше 60% и целевым порогом 70%.

**Acceptance:** интерфейс остаётся понятным при большом scope и не обещает больше, чем подтверждают данные; все ограничения и неизвестные состояния видны оператору.

## Порядок реализации

- [ ] Task 0: UX baseline, locale blocker и утверждение одного design direction.
- [ ] Task 1: общий overview contract.
- [ ] Task 2: dashboard metrics.
- [ ] Task 3: scalable list and service relations.
- [ ] Task 4: availability history.
- [ ] Task 5: global Docker inventory and scope security.
- [ ] Task 6: Dockge 2 control plane.
- [ ] Task 7: docker run conversion audit.
- [ ] Task 8: branding and version 2.x.
- [ ] Task 9: final UX/accessibility/performance QA.

Каждый завершённый Task получает отдельный review и тестовый результат; в master-плане чекбокс отмечается только после прохождения его acceptance и общего `git diff --check`.

## Финальный self-review плана

- [ ] Нет скрытого разрешения на управление всеми контейнерами: inventory и control разделены.
- [ ] Метрики не считают `UNKNOWN`, остановленных агентов или clean-exit worker здоровыми без явного правила.
- [ ] Текущие `composerize`, Docker Compose CLI, Bootstrap и SCSS сначала проверяются, а новые библиотеки добавляются только по измерению.
- [ ] Self-container не может быть удалён общим действием, а Docker socket риск явно отображается.
- [ ] `Dockge 2` как публичное имя и `dockge` как технический идентификатор не смешаны без compatibility plan.
- [ ] Ни одна release-версия и Docker-метка не начинается с major 1.
