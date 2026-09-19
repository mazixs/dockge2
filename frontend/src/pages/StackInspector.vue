<template>
    <div class="inspector">
        <!-- Кто это: состояние, имя и чипы происхождения -->
        <div v-if="loadError" class="attention attention-block" role="alert">
            {{ $t("familiarFileReadError") }} <button class="btn btn-normal" type="button" @click="loadStack">{{ $t("familiarRetry") }}</button>
        </div>
        <div class="head">
            <div class="identity">
                <span class="stack-avatar" :class="`stack-color-${stackColor(stackName)}`" aria-hidden="true">{{ stackName?.slice(0, 1).toUpperCase() }}</span>
                <h1>{{ stackName }}</h1>
                <Uptime :stack="globalStack" />
            </div>

            <div class="facts" role="list">
                <span v-ellipsis-title class="fact">{{ agentLabel }}<span v-if="stackPath" class="path"> · {{ stackPath }}</span></span>
            </div>

            <div v-if="stack.isManagedByDockge && $root.canManageStacks" class="actions">
                <!-- Без значков: подписи и так называют результат, а группа
                         обязана уместиться в одну строку узкой колонки -->
                <button v-if="!active" class="btn btn-sm btn-primary" :disabled="processing" @click="run('startStack')">{{ $t("startStack") }}</button>
                <button v-else class="btn btn-sm btn-normal" :disabled="processing" @click="run('stopStack')">{{ $t("stopStack") }}</button>
                <button v-if="active" class="btn btn-sm btn-normal" :disabled="processing" @click="run('restartStack')">{{ $t("restartStack") }}</button>

                <BDropdown right :text="$t('moreActions')" variant="normal" size="sm">
                    <!-- Значок есть у каждого пункта: без него подпись первого стояла
                         левее остальных, и левый край меню шел лесенкой -->
                    <BDropdownItem :disabled="processing" @click="openUpdatePreview">
                        <InterfaceIcon name="refresh" />{{ updateLabel }}
                    </BDropdownItem>
                    <BDropdownItem @click="showDownDialog = true">
                        <font-awesome-icon icon="stop" />{{ $t("downStack") }}
                    </BDropdownItem>
                    <BDropdownItem @click="showDeleteDialog = true">
                        <font-awesome-icon icon="trash" />{{ $t("deleteStack") }}
                    </BDropdownItem>
                    <!-- Вывод последней команды не исчезает вместе со строкой хода:
                         к нему возвращаются и через минуту после конца -->
                    <BDropdownItem :disabled="!runHasOutput" @click="openRunLog">
                        <InterfaceIcon name="logs" />{{ $t("progressLastRun") }}
                    </BDropdownItem>
                </BDropdown>
            </div>
        </div>

        <div v-if="gitFilesPending && $root.canManageStacks" class="git-update-notice">
            <InterfaceIcon name="git" />
            <div><strong>{{ $t(source.behind > 0 ? "familiarGitNotice" : "pagesLocalChanges") }}</strong><p>{{ $t("familiarGitNoticeHint") }}</p></div>
            <router-link :to="gitUrl" class="btn btn-normal">{{ $t("familiarGitCompare") }}</router-link>
        </div>
        <!-- Ход команды: одна строка под кнопками, видна с любой вкладки. Что
             стало с каждым сервисом, она не повторяет - это говорит таблица
             сервисов теми же словами, которыми отвечает compose -->
        <StackProgress
            v-if="stack.isManagedByDockge && $root.canManageStacks"
            ref="progress"
            :key="stackName"
            :stack-name="stackName"
            :endpoint="endpoint"
            :running="running"
            :elapsed="runElapsed"
            :outcome="runOutcome"
            @abort="abort"
            @progress="onProgress"
        />

        <!-- Обзор, файлы, журнал и терминал - вкладки одной страницы: адрес меняется,
             а страница остается, поэтому переключение происходит на месте. Журнал
             только показывает вывод, оболочки контейнеров живут во вкладке терминала -->
        <nav class="stack-tabs" :aria-label="$t('familiarMainNav')">
            <router-link :to="overviewUrl" :class="{ 'tab-current': tab === 'overview' }"><InterfaceIcon name="box" /> {{ $t("familiarStackOverview") }}</router-link>
            <router-link v-if="$root.canManageStacks" :to="filesUrl" :class="{ 'tab-current': tab === 'files' }"><InterfaceIcon name="file" /> {{ $t("familiarFiles") }}</router-link>
            <router-link v-if="$root.canManageStacks" :to="logsUrl" :class="{ 'tab-current': tab === 'logs' }"><InterfaceIcon name="logs" /> {{ $t("familiarLogs") }}</router-link>
            <router-link v-if="$root.canManageStacks" :to="terminalUrl" :class="{ 'tab-current': tab === 'terminal' }"><InterfaceIcon name="terminal" /> {{ $t("terminal") }}</router-link>
        </nav>
        <p v-if="!$root.canManageStacks" class="faint">{{ $t("familiarViewOnly") }}</p>

        <transition name="tab">
            <div v-show="tab === 'overview'" class="tab-panel">
                <!-- Предпросмотр обновления: что известно до запуска. Ничего не тронуто -->
                <div v-if="preview || previewLoading" class="preview">
                    <div class="preview-head">
                        <span class="preview-title">{{ $t("updatePreviewTitle") }}</span>
                        <button class="row-action" type="button" :title="$t('cancel')" :aria-label="$t('cancel')" @click="preview = null">
                            <font-awesome-icon icon="times" />
                        </button>
                    </div>

                    <p v-if="previewLoading" class="preview-line">{{ $t("updatePreviewCheck") }}…</p>

                    <template v-else-if="preview">
                        <p class="preview-line">
                            {{ previewSourceLine }}
                            <router-link v-if="previewGitPending" :to="gitUrl">{{ $t("familiarGitCompare") }}</router-link>
                        </p>

                        <dl class="preview-images">
                            <template v-for="item in preview.images" :key="item.image">
                                <dt>{{ item.image }}</dt>
                                <dd :class="{ newer: item.newer === true }">{{ imageVerdict(item) }}</dd>
                            </template>
                        </dl>

                        <p v-if="preview.builds" class="preview-line">{{ $t("updatePreviewBuilds") }}</p>

                        <p class="preview-line faint">{{ preview.builds ? $t("updatePreviewStepsBuild") : $t("updatePreviewSteps") }}</p>

                        <div class="preview-actions">
                            <button class="btn btn-sm btn-primary" :disabled="processing" @click="runUpdate">{{ $t("updatePreviewRun") }}</button>
                            <button class="btn btn-sm btn-normal" type="button" @click="preview = null">{{ $t("cancel") }}</button>
                        </div>
                    </template>
                </div>

                <!-- Куда стек выходит наружу: адреса из x-dockge, объявленные в файле -->
                <div v-if="urls.length > 0" class="urls">
                    <a v-for="link in urls" :key="link.url" :href="link.url" target="_blank" rel="noreferrer">{{ link.display }}</a>
                </div>

                <!-- Причина: одна названа словами, рядом - чем ее лечить -->
                <div v-if="issues.length > 0" class="attention attention-block" role="status">
                    <div class="reason-line">
                        <span class="attention-badge">{{ $t("reasonBadge") }}</span>
                        <span class="reason">{{ issueText(issues[0]) }}</span>
                    </div>

                    <div class="reason-actions">
                        <button v-if="firstIssueService && $root.canManageStacks" class="btn btn-sm btn-normal" type="button" @click="openLogs">
                            <InterfaceIcon name="terminal" />{{ $t("serviceLogs", [ firstIssueService ]) }}
                        </button>
                        <button v-if="firstIssueService && $root.canManageStacks" class="btn btn-sm btn-normal" type="button" :disabled="processing" @click="runService('restartService', firstIssueService)">
                            <font-awesome-icon icon="rotate" />{{ $t("restartServiceAction", [ firstIssueService ]) }}
                        </button>
                        <button v-if="issues.length > 1 && !allIssues" class="btn btn-sm btn-normal" type="button" @click="allIssues = true">
                            {{ $t("moreIssues", [ issues.length - 1 ]) }}
                        </button>
                    </div>

                    <ul v-if="allIssues" class="rest">
                        <li v-for="issue in issues.slice(1)" :key="issueText(issue)">{{ issueText(issue) }}</li>
                    </ul>
                </div>

                <div v-if="!stack.isManagedByDockge && !processing" class="attention attention-block">
                    {{ $t("stackNotManagedByDockgeMsg") }}
                </div>

                <div class="inspector-grid">
                    <div class="inspector-main">
                        <!-- Сервисы: таблица с местом под образ, порты и расход -->
                        <div v-if="services.length > 0" class="services">
                            <!-- Шапка таблицы стоит над областью прокрутки, а не в
                                 `caption`: на телефоне таблица шире экрана, и вместе с
                                 ней уезжало вправо все, что в подписи, - счет сервисов,
                                 время проверки и меню колонок. Подпись таблицы осталась
                                 для читающих с экрана -->
                            <div class="services-heading">
                                <strong>{{ $t("pagesServices") }} <span class="service-count">{{ services.length }}</span></strong>
                                <span class="services-checked">{{ $t("pagesChecked", [ statusAge ]) }}</span>
                                <details class="table-options">
                                    <summary :aria-label="$t('moreActions')">⋯</summary>
                                    <label><input v-model="showUsage" type="checkbox"> {{ $t("usageColumn") }}</label>
                                </details>
                            </div>

                            <div class="services-scroll">
                                <table>
                                    <caption class="visually-hidden">{{ $t("pagesServices") }}</caption>
                                    <thead>
                                        <tr>
                                            <th scope="col">{{ $t("serviceColumn") }}</th>
                                            <th scope="col">{{ $t("stateColumn") }}</th>
                                            <th scope="col">{{ $t("imageColumn") }}</th>
                                            <th scope="col">{{ $t("portsColumn") }}</th>
                                            <th v-if="showUsage" scope="col">{{ $t("usageColumn") }}</th>
                                            <th v-if="$root.canManageStacks" scope="col"><span class="visually-hidden">{{ $t("actionsColumn") }}</span></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr v-for="service in services" :key="service.name" class="service-row">
                                            <th scope="row" class="service-name">
                                                <InterfaceIcon name="box" />
                                                {{ service.name }}
                                                <span v-if="service.isOneShot" class="one-shot">{{ $t("oneShotService") }}</span>
                                            </th>
                                            <td class="service-state"><StateChip :state="serviceState(service)" :label="stateLabel(service)" :busy="isServiceBusy(service)" /></td>
                                            <td class="service-image"><details v-if="service.image"><summary :title="service.image">{{ service.image.split("/").pop() }}</summary><code class="full-image">{{ service.image }}</code></details><span v-else>-</span></td>
                                            <td class="service-ports">
                                                <template v-if="service.ports.length > 0">
                                                    <a v-for="port in service.ports" :key="port.display" :href="port.url" target="_blank" rel="noreferrer">{{ port.display }}</a>
                                                </template>
                                                <span v-else class="faint">-</span>
                                            </td>
                                            <td v-if="showUsage" class="service-usage">{{ usageLabel(service) || "-" }}</td>
                                            <td v-if="$root.canManageStacks" class="service-actions">
                                                <button
                                                    class="row-action" type="button" :title="$t('openShell')"
                                                    :disabled="!service.running"
                                                    :aria-label="`${$t('openShell')}: ${service.name}`" @click="openShell(service.name)"
                                                >
                                                    <InterfaceIcon name="terminal" />
                                                </button>
                                                <details class="service-menu" @toggle="placeServiceMenu" @keydown.esc="closeServiceMenu">
                                                    <summary :aria-label="`${$t('moreActions')}: ${service.name}`">⋯</summary><div @click="closeServiceMenu">
                                                        <button
                                                            class="menu-action" type="button"
                                                            :aria-label="`${$t('openLogs')}: ${service.name}`" @click="openLogs"
                                                        >
                                                            <font-awesome-icon icon="list" fixed-width /> {{ $t("openLogs") }}
                                                        </button>
                                                        <button
                                                            v-if="!service.running" class="menu-action" type="button"
                                                            :disabled="processing" :aria-label="`${$t('startStack')}: ${service.name}`"
                                                            @click="runService('startService', service.name)"
                                                        >
                                                            <font-awesome-icon icon="play" fixed-width /> {{ $t("startStack") }}
                                                        </button>
                                                        <button
                                                            v-else class="menu-action" type="button"
                                                            :disabled="processing" :aria-label="`${$t('restartStack')}: ${service.name}`"
                                                            @click="runService('restartService', service.name)"
                                                        >
                                                            <font-awesome-icon icon="rotate" fixed-width /> {{ $t("restartStack") }}
                                                        </button>
                                                        <button v-if="service.running" class="menu-action" type="button" :disabled="processing" :aria-label="`${$t('stopStack')}: ${service.name}`" @click="runService('stopService', service.name)">
                                                            <font-awesome-icon icon="stop" fixed-width /> {{ $t("stopStack") }}
                                                        </button>
                                                    </div>
                                                </details>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <p v-else-if="!processing" class="faint">{{ $t("noServicesInFile") }}</p>

                        <!-- Доступность: окно выбирается, а вывод не выдумывается -->
                        <div class="availability">
                            <div class="availability-head">
                                <span class="availability-title">{{ $t("availabilitySection") }}</span>
                                <div class="windows">
                                    <button
                                        v-for="hours in availabilityWindows" :key="hours"
                                        class="window" type="button"
                                        :aria-pressed="String(windowHours === hours)"
                                        :class="{ on: windowHours === hours }"
                                        @click="selectWindow(hours)"
                                    >
                                        {{ $t(`availabilityWindow${hours}`) }}
                                    </button>
                                </div>
                            </div>

                            <div class="availability-body" :class="`verdict-${availabilityVerdict}`">
                                <span class="verdict">{{ availabilityLabel }}</span>
                                <span v-if="availabilityNote" class="note">{{ availabilityNote }}</span>
                            </div>
                        </div>

                        <!-- Связи, сети и файлы: одна строка, разворачивается на месте -->
                        <div v-if="$root.canManageStacks" class="links">
                            <button class="summary" type="button" :aria-expanded="String(showLinks)" @click="showLinks = !showLinks">
                                <font-awesome-icon :icon="showLinks ? 'chevron-circle-down' : 'chevron-circle-right'" />
                                {{ $t("linksAndNetworks") }}: {{ linksSummary }}
                            </button>
                            <dl v-if="showLinks" class="details">
                                <dt>{{ $t("network", 2) }}</dt>
                                <dd>{{ networkNames.length > 0 ? networkNames.join(", ") : $t("defaultNetworkOnly") }}</dd>
                                <dt>{{ $t("portsColumn") }}</dt>
                                <dd>{{ exposedPorts.length > 0 ? exposedPorts.join(", ") : $t("nothingExposed") }}</dd>
                                <dt>{{ $t("imageColumn") }}</dt>
                                <dd>
                                    <p v-if="registryLabel">{{ registryLabel }}</p>
                                    <span v-for="service in services" :key="service.name" class="image-line">{{ service.name }}: {{ service.image || "-" }}</span>
                                </dd>
                                <dt>{{ $t("stackFiles") }}</dt>
                                <dd>{{ fileNames.join(", ") }}</dd>
                            </dl>
                        </div>
                    </div>
                    <StackSourcePanel :source="source" :directory="stackPath" :files-url="filesUrl" :git-url="gitUrl" :compare-promoted="$root.canManageStacks" />
                </div>
            </div>
        </transition>

        <!-- Файлы: тот же редактор, но внутри страницы стека, а не отдельным экраном.
             Сетка та же, что в обзоре: работа слева, источник справа - страница
             не перестраивается при переходе по вкладкам -->
        <transition name="tab">
            <div v-if="tab === 'files'" class="tab-panel">
                <div class="inspector-grid">
                    <div class="inspector-main">
                        <Compose
                            :key="stackName" ref="filesPanel" embedded
                            :stack-name="stackName" :endpoint-name="endpoint"
                            @run-start="startRunClock" @run-end="stopRunClock"
                        />
                    </div>
                    <StackSourcePanel :source="source" :directory="stackPath" :files-url="filesUrl" :git-url="gitUrl" :compare-promoted="$root.canManageStacks" />
                </div>
            </div>
        </transition>

        <!-- Журнал: вывод стека, только чтение. Сюда смотрят, когда что-то упало -->
        <transition name="tab">
            <div v-if="logsMounted" v-show="tab === 'logs'" class="tab-panel fill">
                <div class="inspector-grid">
                    <div class="inspector-main">
                        <StackJournal :key="stackName" ref="journal" :stack-name="stackName" :endpoint="endpoint" />
                    </div>
                    <StackSourcePanel :source="source" :directory="stackPath" :files-url="filesUrl" :git-url="gitUrl" :compare-promoted="$root.canManageStacks" />
                </div>
            </div>
        </transition>

        <!-- Терминал: оболочки контейнеров. Отдельно от журнала, потому что тут
             команды выполняются, а там только показывается вывод -->
        <transition name="tab">
            <div v-if="terminalMounted" v-show="tab === 'terminal'" class="tab-panel fill">
                <div class="inspector-grid">
                    <div class="inspector-main">
                        <StackTerminals
                            :key="stackName" ref="terminals"
                            :stack-name="stackName" :endpoint="endpoint"
                            :services="services" :request="shellRequest"
                        />
                    </div>
                    <StackSourcePanel :source="source" :directory="stackPath" :files-url="filesUrl" :git-url="gitUrl" :compare-promoted="$root.canManageStacks" />
                </div>
            </div>
        </transition>
        <BModal v-model="showDownDialog" :cancelTitle="$t('cancel')" :okTitle="$t('downStack')" @ok="run('downStack')">{{ $t("familiarDownWarning") }}</BModal>
        <BModal v-model="showDeleteDialog" :cancelTitle="$t('cancel')" :okTitle="$t('deleteStack')" okVariant="danger" @ok="deleteStack">
            {{ $t("familiarDeleteWarning") }}
        </BModal>
    </div>
</template>

<script>
import StateChip from "../components/StateChip.vue";
import InterfaceIcon from "../components/InterfaceIcon.vue";
import { stackColor } from "../stack-color";
import { BModal } from "bootstrap-vue-next";
import { parseDocument } from "yaml";
import dotenv from "dotenv";
import StackSourcePanel from "../components/StackSourcePanel.vue";
import StackJournal from "../components/StackJournal.vue";
import StackTerminals from "../components/StackTerminals.vue";
import StackProgress from "../components/StackProgress.vue";
import Compose from "./Compose.vue";
import Uptime from "../components/Uptime.vue";
import { ATTENTION, RUNNING, envsubstYAML, parseDockerPort } from "../../../common/util-common";
import { summariseRegistries } from "../../../common/image-source";
import { formatDuration, formatPercent } from "../format";
import { stackSourceDiffers, stackSourceState } from "../../../common/stack-source";
import { VERB_KEYS } from "../progress-labels";
import { isUpStatus, parseDockerDuration } from "../../../common/docker-time";

/** Как часто спрашивать состояние сервисов, пока инспектор открыт */
const STATUS_INTERVAL_MS = 5000;

/** Ширина меню сервиса: то же число стоит в .service-menu > div */
const MENU_WIDTH = 190;

/**
 * Глаголы, после которых сервиса на месте больше нет. Остальные готовые шаги
 * означают, что контейнер поднят
 */
const GONE_VERBS = [ "stopped", "removed" ];

/**
 * Имя в шаблон: точки и плюсы встречаются в именах сервисов и не должны
 * превращаться в метасимволы
 * @param {string} value Имя сервиса или стека
 * @returns {string} Безопасный для RegExp кусок
 */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default {
    components: { StateChip,
        InterfaceIcon,
        StackSourcePanel,
        StackJournal,
        StackTerminals,
        StackProgress,
        Compose,
        BModal,
        Uptime,
    },
    beforeRouteUpdate(to, from, next) {
        this.confirmLeavingFiles(next);
    },
    beforeRouteLeave(to, from, next) {
        this.confirmLeavingFiles(next);
    },
    data() {
        return {
            stack: {},
            loadError: false,
            disposed: false,
            showDownDialog: false,
            serviceStatusList: {},
            serviceIssues: [],
            processing: true,
            showDeleteDialog: false,
            showLinks: false,
            showUsage: false,
            allIssues: false,
            statusTimer: null,
            ageTimer: null,
            /** Разобранный compose с подставленными переменными окружения */
            config: {},
            /** Расход контейнеров: приходит отдельным событием, обновляется вместе с состоянием */
            dockerStats: {},
            /** Когда состояние сервисов было получено последний раз */
            statusReadAt: 0,
            /** Секунды с последнего замера, пересчитываются раз в секунду */
            statusAgeSeconds: 0,
            /** Предпросмотр обновления: null пока его не просили */
            preview: null,
            previewLoading: false,
            /** Имя выполняющейся команды, пусто когда ничего не идет */
            running: "",
            /** Сколько секунд идет команда */
            runElapsed: 0,
            /** Чем кончилась последняя команда: пусто, "ok" или "failed" */
            runOutcome: "",
            runTimer: null,
            /** Выбранное окно доступности в часах */
            windowHours: 24,
            /** Доступность выбранного окна, приходит отдельным запросом */
            availabilityData: null,
            /** Журнал остается живым после ухода на другую вкладку: иначе вывод начнется заново */
            logsMounted: false,
            /** Терминал тем более: размонтирование убивает открытые оболочки */
            terminalMounted: false,
            /** Просьба открыть оболочку сервиса, читается вкладкой терминала */
            shellRequest: null,
            /**
             * Шаги идущей команды: пока compose работает, состояние сервиса
             * читается по ним, а не по замеру docker - замер приходит раз в
             * две секунды и все это время показывал бы вчерашний день
             */
            runTasks: [],
            /** Последняя команда что-то сказала: значит, ее вывод есть что открыть */
            runHasOutput: false,
        };
    },
    computed: {
        stackName() {
            return this.$route.params.stackName;
        },

        endpoint() {
            return this.stack.endpoint || this.$route.params.endpoint || "";
        },

        endpointDisplay() {
            return this.$root.endpointDisplayFunction(this.endpoint);
        },

        /** Стек из общего списка: в нем живет состояние, которое обновляет сервер */
        globalStack() {
            return this.$root.completeStackList[`${this.stackName}_${this.endpoint}`];
        },

        /** Где стек живет: свой сервер или агент */
        agentLabel() {
            if (!this.endpoint) {
                return this.$t("thisServer");
            }
            return this.endpointDisplay || this.endpoint;
        },

        /** Каталог стека: он же отвечает на "куда лягут файлы" */
        stackPath() {
            return this.globalStack?.dir ?? "";
        },

        /** Реестры образов одной строкой: "ghcr.io ×2 · Docker Hub ×2" */
        registryLabel() {
            const images = this.services.map((service) => service.image).filter((image) => !!image);
            return summariseRegistries(images)
                .map((entry) => `${entry.registry} ×${entry.count}`)
                .join(" · ");
        },

        source() {
            return this.globalStack?.source ?? null;
        },

        /** Расходятся ли файлы стека с Git: правки на сервере или неперенесенные коммиты */
        gitFilesPending() {
            return stackSourceDiffers(stackSourceState(this.source));
        },

        /**
         * Есть ли что переносить из Git, по тому же чтению, что и остальные строки
         * предпросмотра. Обновление образов файлы не трогает, поэтому рядом со
         * строкой нужен путь к сравнению, а не обещание, что Git подтянется сам.
         */
        previewGitPending() {
            return stackSourceDiffers(stackSourceState(this.preview?.source));
        },

        /** Что предпросмотр говорит про каталог стека */
        previewSourceLine() {
            const source = this.preview?.source;

            if (!source || source.kind !== "git") {
                return this.$t("updatePreviewLocal");
            }

            if (source.dirty) {
                return this.$t("updatePreviewGitDirty");
            }

            if (typeof source.behind === "number" && source.behind > 0) {
                return this.$t("updatePreviewGitBehind", [ source.behind ]);
            }

            return this.$t("updatePreviewGitClean");
        },

        /** Надпись кнопки обновления: отставание в Git называется прямо на кнопке */
        updateLabel() {
            return this.$t("familiarImagesUpdate");
        },

        /** Сервис, из-за которого стек требует внимания: к нему и ведут кнопки починки */
        firstIssueService() {
            return this.issues[0]?.service ?? "";
        },

        /** Возраст замера словами: таблица не выдает старые числа за свежие */
        statusAge() {
            if (!this.statusReadAt) {
                return this.$t("statusAgeUnknown");
            }

            return this.$t("statusAgeSeconds", [ this.statusAgeSeconds ]);
        },

        /** Окна, которые предлагает сервер: сутки, неделя, месяц */
        availabilityWindows() {
            return [ 24, 168, 720 ];
        },

        availabilityVerdict() {
            return this.availabilityData?.verdict ?? "noData";
        },

        /** Вывод по окну словами, по тем же правилам, что в строке списка */
        availabilityLabel() {
            const data = this.availabilityData;

            if (!data) {
                return this.$t("availabilityNoData");
            }

            if (data.verdict === "stopped") {
                return this.$t("availabilityStopped", [ formatDuration(data.currentForMs, this.$t) ]);
            }

            if (data.verdict === "clean") {
                return this.$t("availabilityCleanWindow", [ this.$t(`availabilityWindow${this.windowHours}`) ]);
            }

            if (data.verdict === "degraded" && data.incidents === 0) {
                // Доля упала не из-за сбоя, а из-за остановки: "0 сбоев" было бы враньем
                return formatPercent(data.ratio, this.$i18n.locale, true);
            }

            if (data.verdict === "degraded") {
                return `${formatPercent(data.ratio, this.$i18n.locale, true)} · ${this.$t("availabilityIncidents", data.incidents)}`;
            }

            return this.$t("availabilityNoData");
        },

        /** Приписка: почему доля такая - без нее процент выглядит необъяснимым */
        availabilityNote() {
            const data = this.availabilityData;

            if (!data) {
                return "";
            }

            if (data.verdict === "degraded" && data.incidents === 0) {
                return this.$t("availabilityPartlyStopped");
            }

            if (data.verdict === "noData") {
                return data.coveredMs
                    ? this.$t("availabilityObservedFor", [ formatDuration(data.coveredMs, this.$t) ])
                    : this.$t("availabilityNothingObserved");
            }

            if (data.coveredMs < data.windowMs * 0.98) {
                return this.$t("availabilityCoverage", [ formatDuration(data.coveredMs, this.$t) ]);
            }

            return "";
        },

        gitUrl() {
            return `/stack/${encodeURIComponent(this.stackName)}/git${this.endpoint ? `/${encodeURIComponent(this.endpoint)}` : ""}`;
        },

        /** Какая вкладка открыта: адрес и есть состояние страницы */
        tab() {
            if (this.$route.name === "stackFiles") {
                return "files";
            }
            if (this.$route.name === "stackLogs") {
                return "logs";
            }
            return this.$route.name === "stackTerminal" ? "terminal" : "overview";
        },

        /** Хвост адреса с агентом: у всех вкладок он одинаковый */
        endpointPath() {
            return this.endpoint ? `/${encodeURIComponent(this.endpoint)}` : "";
        },

        overviewUrl() {
            return `/stack/${encodeURIComponent(this.stackName)}${this.endpointPath}`;
        },

        filesUrl() {
            return `/stack/${encodeURIComponent(this.stackName)}/files${this.endpointPath}`;
        },

        logsUrl() {
            return `/stack/${encodeURIComponent(this.stackName)}/logs${this.endpointPath}`;
        },

        terminalUrl() {
            return `/stack/${encodeURIComponent(this.stackName)}/terminal${this.endpointPath}`;
        },

        /** Работает ли стек: хотя бы один запущенный контейнер */
        active() {
            if (this.globalStack?.status === RUNNING) {
                return true;
            }
            if (this.globalStack?.status === ATTENTION) {
                return this.services.some(service => service.running);
            }
            return false;
        },

        issues() {
            if (Array.isArray(this.serviceIssues) && this.serviceIssues.length > 0) {
                return this.serviceIssues;
            }
            return this.globalStack?.issues ?? [];
        },

        /** Сервисы файла, дополненные тем, что о них знает Docker */
        services() {
            const declared = this.config?.services ?? {};
            const names = [ ...new Set([ ...Object.keys(declared), ...Object.keys(this.serviceStatusList), ...(this.globalStack?.services ?? []).map(service => service.name) ]) ];

            return names.map((name) => {
                const service = declared[name] ?? {};
                const instances = Array.isArray(this.serviceStatusList[name]) ? this.serviceStatusList[name] : [];

                return {
                    name,
                    image: service.image ?? "",
                    ports: (service.ports ?? []).map(port => this.parsePort(port)).filter(Boolean),
                    isOneShot: this.globalStack?.services?.find(item => item.name === name)?.isOneShot ?? false,
                    summaryState: this.globalStack?.services?.find(item => item.name === name)?.state ?? "unknown",
                    instances,
                    running: instances.some(instance => instance.state === "running"),
                    attention: instances.some(instance => !!instance.issue),
                };
            });
        },

        /**
         * Шаг команды на каждый сервис, которому он достался. Compose называет
         * контейнеры, а не сервисы, поэтому имя ищется тремя способами: как его
         * знает docker, как оно объявлено в файле и как compose собирает его сам
         */
        runTaskByService() {
            if (this.runTasks.length === 0) {
                return {};
            }

            const map = {};

            for (const service of this.services) {
                const task = this.matchRunTask(service);

                if (task) {
                    map[service.name] = task;
                }
            }

            return map;
        },

        /** Адреса из x-dockge: то, по чему сервис открывают */
        urls() {
            const declared = this.config?.["x-dockge"]?.urls;

            if (!Array.isArray(declared)) {
                return [];
            }

            return declared.flatMap((url) => {
                try {
                    const parsed = new URL(url);
                    if (![ "http:", "https:" ].includes(parsed.protocol)) {
                        return [];
                    }
                    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
                    return { url,
                        display: parsed.host + pathname + parsed.search };
                } catch {
                    return [];
                }
            });
        },

        networkNames() {
            return Object.keys(this.config?.networks ?? {});
        },

        exposedPorts() {
            return this.services.flatMap(service => service.ports.map(port => port.display));
        },

        fileNames() {
            const names = [ this.stack.composeFileName || "compose.yaml" ];
            if (this.stack.composeENV) {
                names.push(".env");
            }
            return names;
        },

        /** Одна строка вместо трех разделов: сколько сервисов, сетей и что наружу */
        linksSummary() {
            const parts = [ this.$t("serviceCount", this.services.length) ];

            // Своих сетей может не быть вовсе: тогда честнее назвать сеть по умолчанию,
            // чем писать "0 сетей"
            if (this.networkNames.length > 0) {
                parts.push(this.$t("networkCount", this.networkNames.length));
            } else {
                parts.push(this.$t("defaultNetworkOnly"));
            }

            if (this.exposedPorts.length > 0) {
                parts.push(this.$t("exposedPortsShort", [ this.exposedPorts.join(", ") ]));
            } else {
                parts.push(this.$t("nothingExposed"));
            }

            return parts.join(", ");
        },
    },
    watch: {
        // Выбор другого стека в списке остается в том же компоненте
        stackName(to, from) {
            this.leaveLogs(from, this.stack.endpoint || "");
            // Просьба открыть оболочку принадлежала прежнему стеку
            this.shellRequest = null;
            this.loadStack();
        },

        tab: {
            immediate: true,
            handler(value) {
                if (value !== "logs" && value !== "terminal") {
                    return;
                }

                if (value === "logs") {
                    this.logsMounted = true;
                } else {
                    this.terminalMounted = true;
                }

                // Скрытый xterm не знает своего размера: показанная вкладка
                // подгоняет консоль заново, иначе вывод остается в чужих колонках
                this.$nextTick(() => {
                    (value === "logs" ? this.$refs.journal : this.$refs.terminals)?.fitActive();
                });
            },
        },
    },
    mounted() {
        this.loadStack();

        // Возраст замера идет секундами: подпись таблицы обещает именно это
        this.ageTimer = setInterval(() => {
            if (this.statusReadAt) {
                this.statusAgeSeconds = Math.round((Date.now() - this.statusReadAt) / 1000);
            }
        }, 1000);
    },
    unmounted() {
        this.disposed = true;
        clearTimeout(this.statusTimer);
        clearInterval(this.ageTimer);
        clearInterval(this.runTimer);
        this.leaveLogs(this.stackName, this.endpoint);
    },
    methods: {
        stackColor,
        /**
         * `getStack` подписывает клиента на вывод стека, поэтому уходя надо отписаться.
         * Журнал этого же стека уходит вместе со страницей, так что чужую подписку
         * это не рвет.
         * @param {string} stackName Стек, от которого уходим
         * @param {string} endpoint Агент
         * @returns {void}
         */
        leaveLogs(stackName, endpoint) {
            if (!this.$root.canManageStacks || !stackName) {
                return;
            }

            this.$root.emitAgent(endpoint, "leaveCombinedTerminal", stackName, () => {});
        },

        /**
         * Уход со вкладки файлов спрашивает про несохраненные правки: редактор
         * больше не отдельная страница, но его вопрос никуда не делся
         * @param {Function} next Продолжение перехода
         * @returns {void}
         */
        confirmLeavingFiles(next) {
            const files = this.$refs.filesPanel;

            if (!files) {
                next();
                return;
            }

            files.exitConfirm(next);
        },

        /**
         * Спросить доступность выбранного окна
         * @returns {void}
         */
        requestAvailability() {
            this.$root.emitAgent(this.endpoint, "stackAvailability", this.stackName, this.windowHours, (res) => {
                this.availabilityData = res?.ok ? res.availability : null;
            });
        },

        /**
         * Выбрать окно доступности
         * @param {number} hours Окно в часах
         * @returns {void}
         */
        selectWindow(hours) {
            this.windowHours = hours;
            this.requestAvailability();
        },

        loadStack() {
            this.processing = true;
            this.loadError = false;
            this.allIssues = false;
            this.serviceStatusList = {};

            if (!this.$root.canManageStacks) {
                this.stack = this.globalStack ?? {};
                this.config = {};
                this.processing = false;
                this.requestServiceStatus();
                this.requestAvailability();
                return;
            }
            this.$root.emitAgent(this.$route.params.endpoint || "", "getStack", this.stackName, (res) => {
                if (this.disposed) {
                    return;
                }
                this.processing = false;

                if (!res.ok) {
                    this.loadError = true;
                    return;
                }

                this.stack = res.stack;
                this.parseConfig();
                this.requestServiceStatus();
                this.requestAvailability();
            });
        },

        /**
         * Разобрать compose с подставленными переменными: инспектор показывает то,
         * что получит Docker, а не текст с ${VAR}
         * @returns {void}
         */
        parseConfig() {
            try {
                const env = dotenv.parse(this.stack.composeENV ?? "");
                const doc = parseDocument(envsubstYAML(this.stack.composeYAML ?? "", env));
                this.config = doc.toJS() ?? {};
            } catch {
                // Файл может быть сломан: тогда инспектор показывает состояние без разбора
                this.config = {};
            }
        },

        requestServiceStatus() {
            if (this.disposed) {
                return;
            }
            this.$root.emitAgent(this.endpoint, "serviceStatusList", this.stackName, (res) => {
                if (this.disposed) {
                    return;
                }
                if (res.ok) {
                    this.serviceStatusList = res.serviceStatusList;
                    this.serviceIssues = res.issues ?? [];
                    this.statusReadAt = Date.now();
                    this.statusAgeSeconds = 0;
                }

                clearTimeout(this.statusTimer);
                this.statusTimer = setTimeout(this.requestServiceStatus, STATUS_INTERVAL_MS);
            });

            // Расход показывается рядом с состоянием, поэтому спрашивается вместе с ним
            this.$root.emitAgent(this.endpoint, "dockerStats", (res) => {
                if (res.ok) {
                    this.dockerStats = res.dockerStats;
                }
            });
        },

        /**
         * Открыть предпросмотр обновления: спросить сервер, что он знает до запуска
         * @returns {void}
         */
        openUpdatePreview() {
            this.previewLoading = true;
            this.preview = null;

            this.$root.emitAgent(this.endpoint, "stackUpdatePreview", this.stackName, (res) => {
                this.previewLoading = false;

                if (!res?.ok) {
                    this.$root.toastRes(res);
                    return;
                }

                this.preview = { source: res.source,
                    images: res.images ?? [] };
            });
        },

        /**
         * Запустить обновление после предпросмотра
         * @returns {void}
         */
        runUpdate() {
            this.preview = null;
            this.run("updateStack");
        },

        /**
         * Прервать выполняющуюся команду стека
         * @returns {void}
         */
        abort() {
            this.$root.emitAgent(this.endpoint, "abortCompose", this.stackName, (res) => {
                this.$root.toastRes(res);
            });
        },

        /**
         * Что известно про один образ: новее, актуален или ответа нет
         * @param {object} item Ответ предпросмотра по образу
         * @returns {string} Вывод словами
         */
        imageVerdict(item) {
            if (item.newer === true) {
                return this.$t("updatePreviewNewer");
            }

            if (item.newer === false) {
                return this.$t("updatePreviewCurrent");
            }

            return item.reason === "notPulled"
                ? this.$t("updatePreviewUnknownNotPulled")
                : this.$t("updatePreviewUnknownRegistry");
        },

        /**
         * Действие над стеком одним событием агента
         * @param {string} event Имя события
         * @returns {void}
         */
        run(event) {
            this.processing = true;
            this.startRunClock(event);

            this.$root.emitAgent(this.endpoint, event, this.stackName, (res) => {
                this.processing = false;
                this.stopRunClock(res?.ok ? "ok" : "failed");
                this.$root.toastRes(res);
                this.requestServiceStatus();
            });
        },

        /**
         * Пока команда идет, секунды считаются, а состояние опрашивается чаще:
         * прогресс имеет смысл только пока он живой
         * @param {string} event Имя события
         * @returns {void}
         */
        startRunClock(event) {
            this.running = event;
            this.runElapsed = 0;
            this.runOutcome = "";
            clearInterval(this.runTimer);
            const startedAt = Date.now();

            this.runTimer = setInterval(() => {
                this.runElapsed = Math.floor((Date.now() - startedAt) / 1000);
                this.requestServiceStatus();
            }, 2000);
        },

        /**
         * Команда кончилась: секунды замирают на последнем значении, а итог
         * читается в панели хода - она не исчезает сама, потому что последние
         * строки вывода нужны и после удачи
         * @param {string} outcome "ok" или "failed"
         * @returns {void}
         */
        stopRunClock(outcome = "") {
            this.running = "";
            this.runOutcome = outcome;
            clearInterval(this.runTimer);
            this.runTimer = null;
        },

        /**
         * Строка хода рассказала, что делает compose: те же шаги читает таблица
         * сервисов, поэтому состояние в ней меняется сразу, а не через замер
         * @param {object} progress Шаги и признак вывода
         * @returns {void}
         */
        onProgress(progress) {
            this.runTasks = progress.tasks;
            this.runHasOutput = progress.hasOutput;
        },

        /** Полный вывод последней команды: он живет в строке хода */
        openRunLog() {
            this.$refs.progress?.openLog();
        },

        /**
         * Шаг команды, который достался этому сервису
         * @param {object} service Сервис с его контейнерами
         * @returns {object|null} Шаг или null, если команда его не касалась
         */
        matchRunTask(service) {
            const names = new Set(service.instances.map((instance) => instance.name).filter(Boolean));
            const declared = this.config?.services?.[service.name]?.container_name;

            if (declared) {
                names.add(declared);
            }

            // Так compose называет контейнер сам: имя стека, имя сервиса и номер копии
            const generated = new RegExp(`^${escapeRegExp(this.stackName)}[-_]${escapeRegExp(service.name)}([-_]\\d+)?$`, "i");
            let container = null;
            let image = null;

            for (const task of this.runTasks) {
                if (task.kind === "container" && (names.has(task.name) || generated.test(task.name))) {
                    container = task;
                } else if (task.kind === "image" && task.name === service.name) {
                    image = task;
                }
            }

            // Контейнер важнее образа: загрузка образа - это еще не сервис
            return container ?? image;
        },

        /**
         * Действие над одним сервисом
         * @param {string} event Имя события
         * @param {string} serviceName Сервис
         * @returns {void}
         */
        runService(event, serviceName) {
            this.processing = true;
            this.startRunClock(event);

            this.$root.emitAgent(this.endpoint, event, this.stackName, serviceName, (res) => {
                this.processing = false;
                this.stopRunClock(res?.ok ? "ok" : "failed");
                this.$root.toastRes(res);
                this.requestServiceStatus();
            });
        },

        deleteStack() {
            this.$root.emitAgent(this.endpoint, "deleteStack", this.stackName, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.$router.push("/");
                }
            });
        },

        /** Вывод стека живет во вкладке журнала этой же страницы */
        openLogs() {
            this.$router.push(this.logsUrl);
        },

        /**
         * Поставить раскрытое меню сервиса под его кнопкой и закрыть его при прокрутке:
         * меню лежит вне потока, поэтому уехавшая страница оставила бы его висеть
         * @param {Event} event Раскрытие или закрытие details
         * @returns {void}
         */
        placeServiceMenu(event) {
            const details = event.target;
            const menu = details.querySelector("div");
            const trigger = details.querySelector("summary");

            if (!details.open || !menu || !trigger) {
                return;
            }

            const rect = trigger.getBoundingClientRect();
            const left = Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8);
            menu.style.top = `${rect.bottom + 4}px`;
            menu.style.left = `${Math.max(8, left)}px`;

            const dismiss = () => details.removeAttribute("open");
            window.addEventListener("scroll", dismiss, { capture: true,
                once: true });
            window.addEventListener("resize", dismiss, { once: true });
        },

        /**
         * Закрыть меню сервиса: выбранное действие уже ушло, открытое меню перекрывает строку
         * @param {Event} event Клик по пункту или Escape внутри меню
         * @returns {void}
         */
        closeServiceMenu(event) {
            event.target.closest("details")?.removeAttribute("open");
        },

        /**
         * Shell контейнера открывается сессией во вкладке терминала. Просьба - новый
         * объект, иначе повторный выбор того же сервиса ничего бы не изменил
         * @param {string} serviceName Сервис
         * @returns {void}
         */
        openShell(serviceName) {
            this.shellRequest = { serviceName,
                shell: "sh",
                at: Date.now() };
            this.$router.push(this.terminalUrl);
        },

        parsePort(port) {
            if (port && typeof port === "object") {
                if (port.target === undefined) {
                    return null;
                }
                port = `${port.published === undefined ? "" : `${port.host_ip ? `${port.host_ip}:` : ""}${port.published}:`}${port.target}/${port.protocol || "tcp"}`;
            }
            if (typeof port !== "string" && typeof port !== "number") {
                return null;
            }
            const hostname = this.stack.endpoint ? this.stack.primaryHostname : (this.$root.info.primaryHostname || location.hostname);
            return parseDockerPort(String(port), hostname);
        },

        /**
         * Расход и аптайм сервиса: память из docker stats, время работы из строки
         * состояния докера. Ничего не выдумывается: нет данных - нет подписи.
         * @param {object} service Сервис с его контейнерами
         * @returns {string} Память и аптайм через точку
         */
        usageLabel(service) {
            const memory = service.instances
                .map((instance) => this.dockerStats[instance.name]?.MemUsage)
                .filter((value) => !!value)
                .map((value) => String(value).split("/")[0]?.trim())
                .filter((value) => !!value)
                .join(", ");

            // Время берется из фразы докера, но выводится нашими словами: иначе в
            // русской панели стояло бы "About a minute ago"
            const uptime = service.instances
                .map((instance) => {
                    const duration = parseDockerDuration(instance.statusText ?? "");

                    if (duration === null) {
                        return "";
                    }

                    const value = formatDuration(duration, this.$t);
                    return isUpStatus(instance.statusText ?? "") ? value : this.$t("agoSuffix", [ value ]);
                })
                .filter((text) => !!text)
                .join(", ");

            return [ memory, uptime ].filter((part) => !!part).join(" · ");
        },

        stateLabel(service) {
            const task = this.runTaskByService[service.name];

            // Пока команда идет, состояние называет compose: он знает про сервис
            // раньше, чем docker успеет ответить на следующий опрос
            if (task) {
                const key = VERB_KEYS[task.verb];
                return key ? this.$t(key) : task.verb;
            }

            if (service.instances.length === 0) {
                return this.$t(`serviceState_${service.summaryState}`);
            }

            const labels = new Set(service.instances.map(instance => {
                if (instance.health) {
                    return this.$t(instance.health);
                }
                return this.$t(instance.state || "unknown");
            }));

            return labels.size === 1 ? [ ...labels ][0] : this.$t("mixedState");
        },

        /**
         * Состояние сервиса именем системы: вид чипа один на весь интерфейс
         * @param {object} service Сервис с его контейнерами
         * @returns {string} Имя состояния
         */
        serviceState(service) {
            const task = this.runTaskByService[service.name];

            if (task) {
                if (task.state === "failed") {
                    return "failed";
                }

                if (task.state === "working") {
                    return "attention";
                }

                return GONE_VERBS.includes(task.verb) ? "stopped" : "running";
            }

            if (service.attention) {
                return "attention";
            }
            return service.instances.length === 0 ? service.summaryState : service.running ? "running" : "stopped";
        },

        /**
         * Над сервисом прямо сейчас работают: точка чипа дышит, пока шаг не готов
         * @param {object} service Сервис с его контейнерами
         * @returns {boolean} Идет ли работа
         */
        isServiceBusy(service) {
            return this.runTaskByService[service.name]?.state === "working";
        },

        issueText(issue) {
            const detail = issue.detail ? ` (${issue.detail})` : "";
            const name = issue.name ? ` / ${issue.name}` : "";
            return `${issue.service}${name}: ${this.$t(issue.reason)}${detail}`;
        },
    },
};
</script>

<style lang="scss" scoped>
// Рабочая область не растягивается на весь монитор: колонки таблицы держатся
// вместе, иначе взгляду приходится ходить через пустоту от имени к расходу
.inspector {
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    max-width: 1100px;
}

// Шапка в одну строку: имя и состояние слева, действия справа, чипы под ними
.head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    grid-template-areas:
        "identity actions"
        "facts actions";
    align-items: start;
    gap: var(--gap-xs) var(--gap-md);

    .identity {
        grid-area: identity;
        display: flex;
        align-items: center;
        gap: var(--gap-sm);
        min-width: 0;
    }

    h1 {
        font-size: var(--text-xl);
        font-weight: var(--weight-strong);
        margin: 0;
        overflow-wrap: anywhere;
    }

    .facts {
        grid-area: facts;
    }

    .actions {
        grid-area: actions;
        display: flex;
        align-items: center;
        gap: var(--gap-xs);
        flex-wrap: wrap;
        justify-content: flex-end;
    }
}

// Чипы происхождения: где живет, из чего состоит, откуда тянет образы
.facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-xs);
    font-size: var(--text-sm);
    color: var(--text-faint);
}

.fact {
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-chip);
    padding: 2px var(--gap-sm);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    .path {
        font-family: var(--font-mono);
    }
}

// Полоса внимания: причина словами и кнопки починки в той же полосе
// Коробку дает система (`.attention-block`); здесь только раскладка:
// на странице стека причина и то, чем ее лечить, стоят друг под другом
.attention {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);

    .reason-line {
        display: flex;
        gap: var(--gap-sm);
        align-items: baseline;
    }

    .reason {
        overflow-wrap: anywhere;
    }

    .reason-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--gap-xs);
    }

    .rest {
        margin: 0;
        padding-left: var(--gap-lg);
        font-size: var(--text-sm);
    }
}

// Таблица сервисов: это главный инструмент открытого стека, поэтому ей отдана
// вся ширина рабочей области
.services {
    // Вбок едет только таблица: шапка с меню колонок стоит над этой областью
    .services-scroll {
        overflow-x: auto;
    }

    // Таблица по содержимому, а не по ширине экрана
    table {
        width: auto;
        min-width: min(100%, 640px);
        border-collapse: collapse;
        font-size: var(--text-sm);
        font-variant-numeric: tabular-nums;
    }

    th, td {
        text-align: left;
        height: var(--row-height-dense);
        padding: 0 var(--gap-md) 0 0;
        border-bottom: 1px solid var(--line-hair);
        vertical-align: middle;
        white-space: nowrap;
    }

    thead th {
        color: var(--text-faint);
        font-weight: var(--weight-medium);
        font-size: var(--text-sm);
        border-bottom-color: var(--line-control);
    }

    tbody tr:hover .service-actions, tbody tr:focus-within .service-actions {
        opacity: 1;
    }
}

.service-name {
    font-weight: var(--weight-strong);
    color: var(--text-strong);

    .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: var(--gap-sm);
        border-radius: var(--radius-pill);
        background-color: var(--state-unknown);

        &.state-running {
            background-color: var(--state-running);
        }

        &.state-attention {
            background-color: var(--state-attention);
        }

        &.state-stopped {
            background-color: var(--state-stopped);
        }
    }

    .one-shot {
        margin-left: var(--gap-sm);
        font-weight: var(--weight-regular);
        font-size: var(--text-sm);
        color: var(--text-faint);
    }
}

.service-state :deep(.state-chip) { font-size: var(--text-sm); }
.service-state {
    color: var(--text-muted);
}

.service-image, .service-usage {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.service-ports a {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    margin-right: var(--gap-sm);
}

.service-actions {
    text-align: right;
    padding-right: 0;
    padding-left: var(--gap-md);
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease);
}

// Действие в строке - значок с подписью для чтения с экрана, цель полного размера
.row-action {
    width: var(--control-height);
    height: var(--control-height);
    background: none;
    border: 0;
    border-radius: var(--radius-control);
    color: var(--text-faint);

    &:hover:not([disabled]) {
        background-color: var(--surface-raised);
        color: var(--text-strong);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }

    // Остановленный контейнер: оболочки в нем нет, и кнопка честно об этом говорит
    &[disabled] {
        opacity: 0.4;
    }
}

.urls {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-sm);

    a {
        font-family: var(--font-mono);
        font-size: var(--text-sm);
        border: 1px solid var(--line-control);
        border-radius: var(--radius-chip);
        padding: 2px var(--gap-sm);
        text-decoration: none;

        &:focus-visible {
            outline: var(--focus-ring);
            outline-offset: var(--focus-offset);
        }
    }
}

.faint {
    color: var(--text-faint);
}

// Предпросмотр обновления: спокойная панель, ничего не запущено
.preview {
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);
    background-color: var(--surface-panel);
    padding: var(--gap-sm) var(--gap-md);
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
}

.preview-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.preview-title {
    font-size: var(--text-sm);
    color: var(--text-faint);
}

.preview-line {
    margin: 0;
    font-size: var(--text-sm);

    &.faint {
        color: var(--text-faint);
        font-size: var(--text-sm);
    }
}

.preview-images {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    gap: 2px var(--gap-sm);
    margin: 0;
    font-size: var(--text-sm);

    dt {
        font-family: var(--font-mono);
        color: var(--text-muted);
        overflow-wrap: anywhere;
    }

    dd {
        margin: 0;
        color: var(--text-faint);
        white-space: nowrap;

        // Новее в реестре - повод нажать "Обновить", поэтому это заметно
        &.newer {
            color: var(--state-attention);
        }
    }
}

.preview-actions {
    display: flex;
    gap: var(--gap-xs);
    margin-top: var(--gap-xs);
}

// Доступность: заголовок с окнами и один вывод словами
.availability {
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);
    background-color: var(--surface-panel);
    padding: var(--gap-sm) var(--gap-md);
}

.availability-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--gap-md);
}

.availability-title {
    font-size: var(--text-sm);
    color: var(--text-faint);
}

.windows {
    display: flex;
    gap: var(--gap-xs);
}

.window {
    min-height: var(--control-height-sm);
    padding: 0 var(--gap-sm);
    background: none;
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-chip);
    color: var(--text-faint);
    font-size: var(--text-sm);

    &.on {
        border-color: var(--accent);
        background-color: var(--accent-soft);
        color: var(--text-strong);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.availability-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: var(--gap-xs);

    .verdict {
        font-size: var(--text-md);
        font-variant-numeric: tabular-nums;
    }

    .note {
        font-size: var(--text-sm);
        color: var(--text-faint);
    }

    &.verdict-clean .verdict {
        color: var(--state-running);
    }

    &.verdict-degraded .verdict {
        color: var(--state-attention);
    }

    &.verdict-noData .verdict {
        color: var(--text-muted);
    }
}

// Связи, сети и файлы: одна спокойная строка, разворачивается на месте
.links {
    .summary {
        display: flex;
        align-items: center;
        gap: var(--gap-sm);
        min-height: var(--control-height);
        text-align: left;
        background: none;
        border: 0;
        padding: 0;
        color: var(--text-faint);
        font-size: var(--text-sm);

        &:hover {
            color: var(--text-strong);
        }

        &:focus-visible {
            outline: var(--focus-ring);
            outline-offset: var(--focus-offset);
        }
    }

    .details {
        display: grid;
        grid-template-columns: minmax(90px, max-content) 1fr;
        gap: var(--gap-xs) var(--gap-md);
        margin: var(--gap-sm) 0 0;
        font-size: var(--text-sm);

        dt {
            color: var(--text-faint);
        }

        dd {
            margin: 0;
            overflow-wrap: anywhere;
        }
    }

    .image-line {
        display: block;
        font-family: var(--font-mono);
        font-size: var(--text-sm);
    }
}
</style>

<style lang="scss" scoped>
// Страница занимает всю высоту рабочей области: консоль журнала и терминала растет до низа
// Размер инициала объявлен один раз: под ним по той же вертикали идут факты о стеке
.inspector { --avatar-size: 46px; max-width: none; gap: var(--gap-xl); flex: 1; }
.head { gap: var(--gap-sm) var(--gap-lg); align-items: center; }
.head .identity { flex-wrap: wrap; gap: var(--gap-md); }
.head h1 { font-size: var(--text-xl); }
.stack-avatar { width: var(--avatar-size); height: var(--avatar-size); display: grid; place-items: center; border-radius: var(--radius-card); color: var(--stack-letter-color, var(--accent-text)); background: var(--stack-letter-background, var(--accent-soft)); font-size: var(--text-title-sm); font-weight: var(--weight-medium); }
.head .facts { padding-left: calc(var(--avatar-size) + var(--gap-md)); }
.fact { padding: 0; border: none; font-size: var(--text-sm); }
.fact + .fact::before { content: "·"; margin: 0 var(--gap-sm); }
.fact .path { display: none; }
.head .actions { gap: var(--gap-sm); }
// Полоса вкладок не рвет страницу: если имена не помещаются, прокручивается
// сама полоса, а не документ
.stack-tabs { display: flex; align-items: center; gap: var(--gap-xl); border-bottom: 1px solid var(--line-hair); overflow-x: auto; scrollbar-width: none; }
.stack-tabs::-webkit-scrollbar { display: none; }
.stack-tabs > * { flex: none; white-space: nowrap; color: var(--text-muted); border: 0; background: none; text-decoration: none; padding: var(--gap-md) 0; font-size: var(--text-base); display: inline-flex; align-items: center; gap: var(--gap-sm); transition: color var(--motion-fast) var(--motion-ease); }
.stack-tabs > *:hover { color: var(--text-strong); }
.stack-tabs > *:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
.stack-tabs .tab-current { color: var(--text-strong); font-weight: var(--weight-medium); border-bottom: 2px solid var(--accent); }
/* Вкладка - часть той же страницы: содержимое сменяется на месте, поэтому
   появление отмечено движением, а уходящая панель убирается сразу - иначе на
   кадр страница становится вдвое выше и список под ней прыгает */
.tab-panel { display: flex; flex-direction: column; gap: var(--gap-md); min-width: 0; }
// Вкладка с консолью тянется до низа страницы; источник справа остается у верхнего края
.tab-panel.fill { flex: 1; }
.tab-panel.fill .inspector-grid { flex: 1; align-items: stretch; }
.tab-panel.fill .inspector-main { min-height: 0; }
.tab-enter-active { transition: opacity var(--motion-base) var(--motion-ease), transform var(--motion-base) var(--motion-ease); }
.tab-enter-from { opacity: 0; transform: translateY(6px); }
.tab-leave-active { display: none !important; }
.git-update-notice { display: flex; align-items: center; gap: var(--gap-md); border: 1px solid color-mix(in srgb, var(--state-changes) 15%, var(--line-hair)); background: color-mix(in srgb, var(--state-changes) 5%, var(--surface-base)); border-radius: var(--radius-panel); padding: var(--gap-md) var(--gap-lg); }
.git-update-notice > svg { color: var(--state-changes); }
.git-update-notice strong { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.git-update-notice p { margin: var(--gap-xs) 0 0; color: var(--text-muted); font-size: var(--text-sm); }
.git-update-notice a { margin-left: auto; white-space: nowrap; font-size: var(--text-sm); }
@media (max-width: 800px) { .git-update-notice { flex-wrap: wrap; } .git-update-notice a { margin-left: 0; } }
.inspector-grid { display: grid; grid-template-columns: minmax(0, 1fr) 265px; gap: var(--gap-lg); align-items: start; }
.inspector-main { min-width: 0; display: flex; flex-direction: column; gap: var(--gap-lg); }
.services table { width: 100%; position: relative; }
.services th, .services td { padding-top: var(--gap-md); padding-bottom: var(--gap-md); }
.services-heading { display: flex; align-items: center; gap: var(--gap-md); padding-bottom: var(--gap-md); color: var(--text-muted); }
.services-heading strong { font-size: var(--text-md); color: var(--text-strong); }
.services-checked { margin-left: auto; font-size: var(--text-sm); }
.table-options { position: relative; }
.table-options summary { cursor: pointer; list-style: none; min-width: var(--control-height); text-align: center; }
.table-options label { display: flex; align-items: center; gap: var(--gap-sm); padding: var(--gap-sm); white-space: nowrap; }
.service-count { font-size: var(--text-xs); padding: 2px var(--gap-xs); background: var(--surface-raised); border-radius: var(--radius-chip); }
.usage-toggle { margin-left: var(--gap-sm); color: var(--text-muted); background: none; border: 0; text-decoration: underline; }
.service-menu { display: inline-block; position: relative; }
.service-menu summary { cursor: pointer; list-style: none; padding: var(--gap-sm); min-height: var(--control-height); }
summary:focus-visible, .usage-toggle:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
/* Меню всплывает над страницей: раскрытие внутри ячейки раздвигало таблицу, а
   прокручиваемая область таблицы обрезала нижние пункты. Координаты ставит
   placeServiceMenu, поэтому положение не зависит от прокрутки таблицы */
.service-menu > div { position: fixed; z-index: var(--layer-dock); display: flex; flex-direction: column; width: 190px; padding: var(--gap-xs); background: var(--surface-panel); border: 1px solid var(--line-hair); border-radius: var(--radius-panel); box-shadow: var(--shadow-panel); }
.menu-action { display: flex; align-items: center; gap: var(--gap-sm); width: 100%; min-height: var(--control-height); padding: 0 var(--gap-sm); border: 0; border-radius: var(--radius-control); background: none; color: var(--text-strong); font-size: var(--text-sm); text-align: left; transition: background var(--motion-fast) var(--motion-ease); }
.menu-action:hover:not(:disabled) { background: var(--surface-raised); }
.menu-action:disabled { color: var(--text-faint); }
.menu-action svg { color: var(--text-muted); }
.service-image summary { cursor: pointer; }
.full-image { display: block; user-select: all; white-space: normal; overflow-wrap: anywhere; margin-top: var(--gap-sm); }
.services td.service-image { max-width: 210px; min-width: 100px; white-space: normal; overflow-wrap: anywhere; font-size: var(--text-sm); }
.service-actions { min-width: 80px; opacity: 1; }
.service-usage { white-space: normal; font-size: var(--text-sm); }
.availability { padding: var(--gap-md) 0 0; border: 0; border-top: 1px solid var(--line-hair); border-radius: 0; background: transparent; }
.availability-body { flex-direction: row; align-items: baseline; flex-wrap: wrap; gap: var(--gap-xs) var(--gap-md); margin-top: var(--gap-sm); }
.availability-body .verdict { font-size: var(--text-sm); }
.window { border-color: transparent; }
.window.on { border-color: var(--line-hair); background: var(--surface-raised); color: var(--text-strong); }
.availability-head { gap: var(--gap-md); flex-wrap: wrap; }
.preview { border-radius: var(--radius-panel); padding: var(--gap-lg); }
@media (max-width: 1250px) { .inspector-grid { grid-template-columns: minmax(0,1fr); } .head { display: flex; flex-wrap: wrap; } .head .facts { width: 100%; padding-left: 0; } .head .actions { justify-content: flex-start; } }
@media (max-width: 800px) { .head h1 { font-size: var(--text-title-sm); } .stack-avatar { --avatar-size: var(--gap-3xl); font-size: var(--text-lg); } .services-scroll { overflow-x: auto; } .services table { min-width: 580px; } .head .actions { gap: var(--gap-sm); } .stack-tabs { gap: var(--gap-lg); } }
// На телефоне четыре вкладки не помещаются целиком: имя вкладки важнее значка,
// поэтому значок уходит, а строка остается видимой без прокрутки
@media (max-width: 480px) { .stack-tabs { gap: var(--gap-lg); } .stack-tabs > * > svg { display: none; } }
</style>
