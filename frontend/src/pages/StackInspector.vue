<template>
    <transition name="slide-fade" appear>
        <div class="inspector">
            <!-- Кто это: состояние, имя и чипы происхождения -->
            <div class="head">
                <div class="identity">
                    <Uptime :stack="globalStack" />
                    <h1>{{ stackName }}</h1>
                </div>

                <div class="facts">
                    <span class="fact" :title="stackPath">{{ agentLabel }}<span v-if="stackPath" class="path"> · {{ stackPath }}</span></span>
                    <span class="fact">{{ $t("serviceCount", services.length) }}</span>
                    <span v-if="registryLabel" class="fact">{{ registryLabel }}</span>
                    <span v-if="sourceFact" class="fact" :title="sourceTitle">{{ sourceFact }}</span>
                </div>

                <div v-if="stack.isManagedByDockge" class="actions">
                    <!-- Без значков: подписи и так называют результат, а группа
                         обязана уместиться в одну строку узкой колонки -->
                    <button v-if="!active" class="btn btn-sm btn-normal" :disabled="processing" @click="run('startStack')">{{ $t("startStack") }}</button>
                    <button v-else class="btn btn-sm btn-normal" :disabled="processing" @click="run('stopStack')">{{ $t("stopStack") }}</button>
                    <button class="btn btn-sm btn-normal" :disabled="processing" @click="run('restartStack')">{{ $t("restartStack") }}</button>
                    <!-- Обновление - главное действие открытого стека, поэтому акцент на нём -->
                    <button class="btn btn-sm btn-primary" :disabled="processing" @click="openUpdatePreview">{{ updateLabel }}</button>

                    <BDropdown right :text="$t('moreActions')" variant="normal" size="sm">
                        <BDropdownItem @click="openLogs">
                            <font-awesome-icon icon="stream" class="me-1" />{{ $t("openLogs") }}
                        </BDropdownItem>
                        <BDropdownItem :to="composeUrl">
                            <font-awesome-icon icon="pen" class="me-1" />{{ $t("openComposeFile") }}
                        </BDropdownItem>
                        <BDropdownItem @click="run('downStack')">
                            <font-awesome-icon icon="stop" class="me-1" />{{ $t("downStack") }}
                        </BDropdownItem>
                        <BDropdownItem @click="showDeleteDialog = true">
                            <font-awesome-icon icon="trash" class="me-1" />{{ $t("deleteStack") }}
                        </BDropdownItem>
                    </BDropdown>
                </div>
            </div>

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
                    <p class="preview-line">{{ previewSourceLine }}</p>

                    <dl class="preview-images">
                        <template v-for="item in preview.images" :key="item.image">
                            <dt>{{ item.image }}</dt>
                            <dd :class="{ newer: item.newer === true }">{{ imageVerdict(item) }}</dd>
                        </template>
                    </dl>

                    <p class="preview-line faint">{{ $t("updatePreviewSteps") }}</p>

                    <div class="preview-actions">
                        <button class="btn btn-sm btn-primary" :disabled="processing" @click="runUpdate">{{ $t("updatePreviewRun") }}</button>
                        <button class="btn btn-sm btn-normal" type="button" @click="preview = null">{{ $t("cancel") }}</button>
                    </div>
                </template>
            </div>

            <!-- Выполнение: идут секунды, видно каждый контейнер, и это можно прервать -->
            <div v-if="running" class="running" role="status">
                <div class="running-head">
                    <span><i class="dot attention" aria-hidden="true"></i>{{ $t("deployRunningFor", [ runElapsed ]) }}</span>
                    <button class="btn btn-sm btn-normal" type="button" @click="abort">{{ $t("abortRunning") }}</button>
                </div>

                <div v-for="service in services" :key="service.name" class="running-row">
                    <span class="running-name">{{ service.name }}</span>
                    <span class="running-what">{{ progressLabel(service) }}</span>
                </div>
            </div>

            <!-- Куда стек выходит наружу: адреса из x-dockge, объявленные в файле -->
            <div v-if="urls.length > 0" class="urls">
                <a v-for="link in urls" :key="link.url" :href="link.url" target="_blank" rel="noreferrer">{{ link.display }}</a>
            </div>

            <!-- Причина: одна названа словами, рядом - чем её лечить -->
            <div v-if="issues.length > 0" class="attention" role="status">
                <div class="reason-line">
                    <span class="reason-badge">{{ $t("reasonBadge") }}</span>
                    <span class="reason">{{ issueText(issues[0]) }}</span>
                </div>

                <div class="reason-actions">
                    <button v-if="firstIssueService" class="btn btn-sm btn-normal" type="button" @click="openLogs">
                        <font-awesome-icon icon="stream" class="me-1" />{{ $t("serviceLogs", [ firstIssueService ]) }}
                    </button>
                    <button v-if="firstIssueService" class="btn btn-sm btn-normal" type="button" :disabled="processing" @click="runService('restartService', firstIssueService)">
                        <font-awesome-icon icon="rotate" class="me-1" />{{ $t("restartServiceAction", [ firstIssueService ]) }}
                    </button>
                    <button v-if="issues.length > 1 && !allIssues" class="btn btn-sm btn-normal" type="button" @click="allIssues = true">
                        {{ $t("moreIssues", [ issues.length - 1 ]) }}
                    </button>
                </div>

                <ul v-if="allIssues" class="rest">
                    <li v-for="issue in issues.slice(1)" :key="issueText(issue)">{{ issueText(issue) }}</li>
                </ul>
            </div>

            <div v-if="!stack.isManagedByDockge && !processing" class="attention">
                {{ $t("stackNotManagedByDockgeMsg") }}
            </div>

            <!-- Сервисы: имя слева, расход справа. Действия появляются при наведении
                 и по фокусу с клавиатуры, чтобы строка оставалась спокойной -->
            <div v-if="services.length > 0" class="services">
                <div class="services-title">{{ $t("servicesCaption", [ statusAge ]) }}</div>

                <div v-for="service in services" :key="service.name" class="service-row">
                    <span class="service-name">
                        <i class="dot" :class="`state-${serviceState(service)}`" aria-hidden="true"></i>
                        {{ service.name }}
                        <span v-if="service.isOneShot" class="one-shot">{{ $t("oneShotService") }}</span>
                    </span>

                    <span class="service-usage">{{ usageLabel(service) || stateLabel(service) }}</span>

                    <span class="service-actions">
                        <button
                            class="row-action" type="button" :title="$t('openLogs')"
                            :aria-label="`${$t('openLogs')}: ${service.name}`" @click="openLogs"
                        >
                            <font-awesome-icon icon="stream" />
                        </button>
                        <button
                            v-if="service.running" class="row-action" type="button" :title="$t('openShell')"
                            :aria-label="`${$t('openShell')} ${service.name}`" @click="openShell(service.name)"
                        >
                            <font-awesome-icon icon="terminal" />
                        </button>
                        <button
                            v-if="!service.running" class="row-action" type="button" :title="$t('startStack')"
                            :disabled="processing" :aria-label="`${$t('startStack')} ${service.name}`"
                            @click="runService('startService', service.name)"
                        >
                            <font-awesome-icon icon="play" />
                        </button>
                        <button
                            v-else class="row-action" type="button" :title="$t('restartStack')"
                            :disabled="processing" :aria-label="`${$t('restartStack')} ${service.name}`"
                            @click="runService('restartService', service.name)"
                        >
                            <font-awesome-icon icon="rotate" />
                        </button>
                    </span>
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
            <div class="links">
                <button class="summary" type="button" :aria-expanded="String(showLinks)" @click="showLinks = !showLinks">
                    <font-awesome-icon :icon="showLinks ? 'chevron-circle-down' : 'chevron-circle-right'" class="me-2" />
                    {{ $t("linksAndNetworks") }}: {{ linksSummary }}
                </button>
                <dl v-if="showLinks" class="details">
                    <dt>{{ $t("network", 2) }}</dt>
                    <dd>{{ networkNames.length > 0 ? networkNames.join(", ") : $t("defaultNetworkOnly") }}</dd>
                    <dt>{{ $t("portsColumn") }}</dt>
                    <dd>{{ exposedPorts.length > 0 ? exposedPorts.join(", ") : $t("nothingExposed") }}</dd>
                    <dt>{{ $t("imageColumn") }}</dt>
                    <dd>
                        <span v-for="service in services" :key="service.name" class="image-line">{{ service.name }}: {{ service.image || "—" }}</span>
                    </dd>
                    <dt>{{ $t("stackFiles") }}</dt>
                    <dd>{{ fileNames.join(", ") }}</dd>
                </dl>
            </div>

            <BModal v-model="showDeleteDialog" :cancelTitle="$t('cancel')" :okTitle="$t('deleteStack')" okVariant="danger" @ok="deleteStack">
                {{ $t("deleteStackMsg") }}
            </BModal>
        </div>
    </transition>
</template>

<script>
import { BModal } from "bootstrap-vue-next";
import { parseDocument } from "yaml";
import dotenv from "dotenv";
import Uptime from "../components/Uptime.vue";
import { ATTENTION, RUNNING, envsubstYAML, parseDockerPort } from "../../../common/util-common";
import { summariseRegistries } from "../../../common/image-source";
import { formatDuration, formatPercent } from "../format";
import { isUpStatus, parseDockerDuration } from "../../../common/docker-time";

/** Как часто спрашивать состояние сервисов, пока инспектор открыт */
const STATUS_INTERVAL_MS = 5000;

export default {
    components: {
        BModal,
        Uptime,
    },
    data() {
        return {
            stack: {},
            serviceStatusList: {},
            serviceIssues: [],
            processing: true,
            showDeleteDialog: false,
            showLinks: false,
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
            /** Имя выполняющейся команды, пусто когда ничего не идёт */
            running: "",
            /** Сколько секунд идёт команда */
            runElapsed: 0,
            runTimer: null,
            /** Выбранное окно доступности в часах */
            windowHours: 24,
            /** Доступность выбранного окна, приходит отдельным запросом */
            availabilityData: null,
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

        /** Стек из общего списка: в нём живёт состояние, которое обновляет сервер */
        globalStack() {
            return this.$root.completeStackList[`${this.stackName}_${this.endpoint}`];
        },

        /** Где стек живёт: свой сервер или агент */
        agentLabel() {
            if (!this.endpoint) {
                return this.$t("thisServer");
            }
            return this.endpointDisplay || this.endpoint;
        },

        /** Каталог стека: он же отвечает на «куда лягут файлы» */
        stackPath() {
            return this.globalStack?.dir ?? "";
        },

        /** Реестры образов одной строкой: «ghcr.io ×2 · Docker Hub ×2» */
        registryLabel() {
            const images = this.services.map((service) => service.image).filter((image) => !!image);
            return summariseRegistries(images)
                .map((entry) => `${entry.registry} ×${entry.count}`)
                .join(" · ");
        },

        source() {
            return this.globalStack?.source ?? null;
        },

        /** Источник каталога словами, из того же чтения, что и в списке */
        sourceFact() {
            if (!this.source) {
                return "";
            }

            if (this.source.kind !== "git") {
                return this.$t("sourceLocal");
            }

            const behind = this.source.behind;
            const remote = this.source.remote || "Git";

            if (typeof behind === "number" && behind > 0) {
                return `${remote} · ${this.$t("sourceBehindShort", [ behind ])}`;
            }

            if (typeof behind === "number") {
                return `${remote} · ${this.$t("sourceInSyncShort")}`;
            }

            return remote;
        },

        sourceTitle() {
            if (this.source?.kind !== "git") {
                return "";
            }

            const parts = [ this.source.branch ].filter((part) => !!part);

            if (this.source.dirty) {
                parts.push(this.$t("sourceDirty"));
            }

            return parts.join(" · ");
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
            const behind = this.source?.behind;

            if (this.source?.kind === "git" && typeof behind === "number" && behind > 0) {
                return this.$t("updateFromGit");
            }

            return this.$t("updateStack");
        },

        /** Сервис, из-за которого стек требует внимания: к нему и ведут кнопки починки */
        firstIssueService() {
            return this.issues[0]?.service ?? "";
        },

        /** Возраст замера словами: таблица не выдаёт старые числа за свежие */
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

            if (data.verdict === "degraded") {
                return `${formatPercent(data.ratio, this.$i18n.locale)} · ${this.$t("availabilityIncidents", data.incidents)}`;
            }

            return this.$t("availabilityNoData");
        },

        /** Приписка: сколько окна вообще наблюдалось - без неё процент выглядит полным */
        availabilityNote() {
            const data = this.availabilityData;

            if (!data) {
                return "";
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

        composeUrl() {
            return this.endpoint ? `/compose/${this.stackName}/${this.endpoint}` : `/compose/${this.stackName}`;
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

            return Object.keys(declared).map((name) => {
                const service = declared[name] ?? {};
                const instances = Array.isArray(this.serviceStatusList[name]) ? this.serviceStatusList[name] : [];

                return {
                    name,
                    image: service.image ?? "",
                    ports: (service.ports ?? []).map(port => this.parsePort(String(port))),
                    instances,
                    running: instances.some(instance => instance.state === "running"),
                    attention: instances.some(instance => !!instance.issue),
                };
            });
        },

        /** Адреса из x-dockge: то, по чему сервис открывают */
        urls() {
            const declared = this.config?.["x-dockge"]?.urls;

            if (!Array.isArray(declared)) {
                return [];
            }

            return declared.map((url) => {
                try {
                    const parsed = new URL(url);
                    const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
                    return { url,
                        display: parsed.host + pathname + parsed.search };
                } catch {
                    return { url,
                        display: url };
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

        /** Одна строка вместо трёх разделов: сколько сервисов, сетей и что наружу */
        linksSummary() {
            const parts = [ this.$t("serviceCount", this.services.length) ];

            // Своих сетей может не быть вовсе: тогда честнее назвать сеть по умолчанию,
            // чем писать «0 сетей»
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
        // Выбор другого стека в списке остаётся в том же компоненте
        stackName(to, from) {
            this.leaveLogsUnlessDocked(from, this.stack.endpoint || "");
            this.loadStack();
        },
    },
    mounted() {
        this.loadStack();

        // Возраст замера идёт секундами: подпись таблицы обещает именно это
        this.ageTimer = setInterval(() => {
            if (this.statusReadAt) {
                this.statusAgeSeconds = Math.round((Date.now() - this.statusReadAt) / 1000);
            }
        }, 1000);
    },
    unmounted() {
        clearTimeout(this.statusTimer);
        clearInterval(this.ageTimer);
        clearInterval(this.runTimer);
        this.leaveLogsUnlessDocked(this.stackName, this.endpoint);
    },
    methods: {
        /**
         * `getStack` подписывает клиента на вывод стека, поэтому уходя надо отписаться.
         * Если тот же вывод открыт в доке, подписка остаётся его делом.
         * @param {string} stackName Стек, от которого уходим
         * @param {string} endpoint Агент
         * @returns {void}
         */
        leaveLogsUnlessDocked(stackName, endpoint) {
            if (!stackName || this.$root.dockHasLogs?.(stackName, endpoint)) {
                return;
            }

            this.$root.emitAgent(endpoint, "leaveCombinedTerminal", stackName, () => {});
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
            this.allIssues = false;
            this.serviceStatusList = {};

            this.$root.emitAgent(this.$route.params.endpoint || "", "getStack", this.stackName, (res) => {
                this.processing = false;

                if (!res.ok) {
                    this.$root.toastRes(res);
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
            this.$root.emitAgent(this.endpoint, "serviceStatusList", this.stackName, (res) => {
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
         * Слово о том, что сейчас с сервисом: во время выполнения важно не состояние
         * вообще, а то, чего именно ждём
         * @param {object} service Сервис с его контейнерами
         * @returns {string} Что происходит
         */
        progressLabel(service) {
            const instances = service.instances ?? [];

            if (instances.length === 0) {
                return this.$t("serviceQueued");
            }

            if (instances.some((instance) => instance.health === "starting")) {
                return this.$t("serviceWaitingHealth");
            }

            if (instances.every((instance) => instance.health === "healthy")) {
                return this.$t("serviceHealthy");
            }

            if (instances.some((instance) => instance.state === "created")) {
                return this.$t("serviceQueued");
            }

            return this.stateLabel(service);
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
                this.stopRunClock();
                this.$root.toastRes(res);
                this.requestServiceStatus();
            });
        },

        /**
         * Пока команда идёт, секунды считаются, а состояние опрашивается чаще:
         * прогресс имеет смысл только пока он живой
         * @param {string} event Имя события
         * @returns {void}
         */
        startRunClock(event) {
            this.running = event;
            this.runElapsed = 0;
            clearInterval(this.runTimer);

            this.runTimer = setInterval(() => {
                this.runElapsed += 1;
                this.requestServiceStatus();
            }, 2000);
        },

        stopRunClock() {
            this.running = "";
            clearInterval(this.runTimer);
            this.runTimer = null;
        },

        /**
         * Действие над одним сервисом
         * @param {string} event Имя события
         * @param {string} serviceName Сервис
         * @returns {void}
         */
        runService(event, serviceName) {
            this.processing = true;
            this.$root.emitAgent(this.endpoint, event, this.stackName, serviceName, (res) => {
                this.processing = false;
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

        /** Вывод стека уходит в общий док: он остаётся открытым при переходе к другому стеку */
        openLogs() {
            this.$root.openStackLogs?.(this.stackName, this.endpoint);
        },

        /**
         * Shell контейнера тоже открывается в доке, а не отдельной страницей
         * @param {string} serviceName Сервис
         * @returns {void}
         */
        openShell(serviceName) {
            this.$root.openContainerShell?.({
                stackName: this.stackName,
                serviceName,
                shell: "bash",
                endpoint: this.endpoint,
            });
        },

        parsePort(port) {
            const hostname = this.stack.endpoint ? this.stack.primaryHostname : (this.$root.info.primaryHostname || location.hostname);
            return parseDockerPort(port, hostname);
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

            // Время берётся из фразы докера, но выводится нашими словами: иначе в
            // русской панели стояло бы «About a minute ago»
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
            if (service.instances.length === 0) {
                return this.$t("unknown");
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
            if (service.attention) {
                return "attention";
            }
            return service.running ? "running" : "stopped";
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
.inspector {
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
}

.head {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);

    .identity {
        display: flex;
        align-items: center;
        gap: var(--gap-sm);
        min-width: 0;
    }

    h1 {
        font-size: var(--text-lg);
        font-weight: 600;
        margin: 0;
        overflow-wrap: anywhere;
    }

    .actions {
        display: flex;
        align-items: center;
        gap: var(--gap-xs);
        flex-wrap: wrap;
    }
}

// Чипы происхождения: где живёт, из чего состоит, откуда тянет образы
.facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-xs);
    font-size: var(--text-xs);
    color: var(--text-faint);
}

.fact {
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-chip);
    padding: 1px 6px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    .path {
        font-family: var(--font-mono);
    }
}

// Полоса внимания: причина словами и кнопки починки в той же полосе
.attention {
    border: 1px solid color-mix(in srgb, var(--state-attention) 45%, transparent);
    background-color: color-mix(in srgb, var(--state-attention) 8%, transparent);
    border-radius: var(--radius-panel);
    padding: var(--gap-sm) var(--gap-md);
    color: var(--text-strong);
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);

    .reason-line {
        display: flex;
        gap: var(--gap-sm);
        align-items: baseline;
    }

    .reason-badge {
        flex: none;
        font-size: var(--text-xs);
        text-transform: lowercase;
        color: var(--state-attention);
        border: 1px solid color-mix(in srgb, var(--state-attention) 45%, transparent);
        border-radius: var(--radius-chip);
        padding: 0 6px;
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

// Сервисы: пары «имя - расход», разделители тонкие, действия проявляются
.services {
    border-top: 1px solid var(--line-hair);
}

.services-title {
    padding: var(--gap-sm) 0 var(--gap-xs);
    font-size: var(--text-xs);
    color: var(--text-faint);
}

.service-row {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    min-height: var(--row-height-dense);
    border-top: 1px solid var(--line-hair);

    &:hover .service-actions, &:focus-within .service-actions {
        opacity: 1;
    }
}

.service-name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    .dot {
        width: 7px;
        height: 7px;
        border-radius: var(--radius-pill);
        flex: none;
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
        font-weight: 400;
        font-size: var(--text-xs);
        color: var(--text-faint);
    }
}

.service-usage {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-muted);
    white-space: nowrap;
}

.service-actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity ease-in-out 0.1s;
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
        padding: 2px 8px;
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
    font-size: var(--text-xs);
    color: var(--text-faint);
}

.preview-line {
    margin: 0;
    font-size: var(--text-sm);

    &.faint {
        color: var(--text-faint);
        font-size: var(--text-xs);
    }
}

.preview-images {
    display: grid;
    grid-template-columns: minmax(0, 1fr) max-content;
    gap: 2px var(--gap-sm);
    margin: 0;
    font-size: var(--text-xs);

    dt {
        font-family: var(--font-mono);
        color: var(--text-muted);
        overflow-wrap: anywhere;
    }

    dd {
        margin: 0;
        color: var(--text-faint);
        white-space: nowrap;

        // Новее в реестре - повод нажать «Обновить», поэтому это заметно
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

// Выполнение: секунды идут, каждый контейнер виден, команду можно прервать
.running {
    border: 1px solid color-mix(in srgb, var(--state-attention) 45%, transparent);
    border-radius: var(--radius-panel);
    padding: var(--gap-sm) var(--gap-md);
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);

    .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: 6px;
        border-radius: var(--radius-pill);
        background-color: var(--state-attention);
    }
}

.running-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-sm);
    font-size: var(--text-sm);
}

.running-row {
    display: flex;
    justify-content: space-between;
    gap: var(--gap-sm);
    font-size: var(--text-xs);
}

.running-name {
    font-weight: 500;
}

.running-what {
    color: var(--text-faint);
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
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-sm);
}

.availability-title {
    font-size: var(--text-xs);
    color: var(--text-faint);
}

.windows {
    display: flex;
    gap: var(--gap-xs);
}

.window {
    min-height: 24px;
    padding: 0 var(--gap-sm);
    background: none;
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-chip);
    color: var(--text-faint);
    font-size: var(--text-xs);

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
    margin-top: 4px;

    .verdict {
        font-size: var(--text-md);
        font-variant-numeric: tabular-nums;
    }

    .note {
        font-size: var(--text-xs);
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
        font-size: var(--text-xs);
    }
}
</style>
