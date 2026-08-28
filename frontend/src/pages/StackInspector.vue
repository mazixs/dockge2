<template>
    <transition name="slide-fade" appear>
        <div class="inspector">
            <!-- Кто это и что с ним можно сделать: одна строка, ничего между -->
            <div class="head">
                <div class="identity">
                    <Uptime :stack="globalStack" :pill="true" />
                    <h1>{{ stackName }}</h1>
                    <span v-if="$root.agentCount > 1 && endpoint !== ''" class="agent">{{ endpointDisplay }}</span>
                </div>

                <div v-if="stack.isManagedByDockge" class="actions">
                    <button v-if="!active" class="btn btn-primary" :disabled="processing" @click="run('startStack')">
                        <font-awesome-icon icon="play" class="me-1" />{{ $t("startStack") }}
                    </button>
                    <button v-else class="btn btn-normal" :disabled="processing" @click="run('stopStack')">
                        <font-awesome-icon icon="stop" class="me-1" />{{ $t("stopStack") }}
                    </button>
                    <button class="btn btn-normal" :disabled="processing" @click="run('restartStack')">
                        <font-awesome-icon icon="rotate" class="me-1" />{{ $t("restartStack") }}
                    </button>
                    <button class="btn btn-normal" :disabled="processing" @click="run('updateStack')">
                        <font-awesome-icon icon="cloud-arrow-down" class="me-1" />{{ $t("updateStack") }}
                    </button>

                    <BDropdown right :text="$t('moreActions')" variant="normal">
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

            <!-- Куда стек выходит наружу: адреса из x-dockge, объявленные в файле -->
            <div v-if="urls.length > 0" class="urls">
                <a v-for="link in urls" :key="link.url" :href="link.url" target="_blank" rel="noreferrer">{{ link.display }}</a>
            </div>

            <!-- Строка внимания: называется одна причина, из-за которой стек не в порядке -->
            <div v-if="issues.length > 0" class="attention" role="status">
                <font-awesome-icon icon="triangle-exclamation" class="me-2" />
                <span class="reason">{{ issueText(issues[0]) }}</span>
                <button v-if="issues.length > 1 && !allIssues" class="btn-link" type="button" @click="allIssues = true">
                    {{ $t("moreIssues", [ issues.length - 1 ]) }}
                </button>
                <ul v-if="allIssues" class="rest">
                    <li v-for="issue in issues.slice(1)" :key="issueText(issue)">{{ issueText(issue) }}</li>
                </ul>
            </div>

            <div v-if="!stack.isManagedByDockge && !processing" class="attention">
                {{ $t("stackNotManagedByDockgeMsg") }}
            </div>

            <!-- Сервисы: то, из чего стек состоит, и что с каждым можно сделать -->
            <table v-if="services.length > 0" class="services">
                <caption class="visually-hidden">{{ $t("servicesSection") }}</caption>
                <thead>
                    <tr>
                        <th scope="col">{{ $t("serviceColumn") }}</th>
                        <th scope="col">{{ $t("stateColumn") }}</th>
                        <th scope="col">{{ $t("imageColumn") }}</th>
                        <th scope="col">{{ $t("portsColumn") }}</th>
                        <th scope="col"><span class="visually-hidden">{{ $t("actionsColumn") }}</span></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="service in services" :key="service.name">
                        <th scope="row" class="name">{{ service.name }}</th>
                        <td>
                            <span class="badge" :class="stateClass(service)">
                                <font-awesome-icon v-if="service.attention" icon="triangle-exclamation" class="me-1" />{{ stateLabel(service) }}
                            </span>
                        </td>
                        <td class="image">{{ service.image || "—" }}</td>
                        <td class="ports">
                            <template v-if="service.ports.length > 0">
                                <a v-for="port in service.ports" :key="port.display" :href="port.url" target="_blank" rel="noreferrer">{{ port.display }}</a>
                            </template>
                            <span v-else class="faint">—</span>
                        </td>
                        <td class="row-actions">
                            <!-- Подпись видна короткой, а озвучивается вместе с именем сервиса -->
                            <button v-if="!service.running" class="btn btn-sm btn-normal" :disabled="processing" :aria-label="`${$t('startStack')} ${service.name}`" @click="runService('startService', service.name)">{{ $t("startStack") }}</button>
                            <button v-else class="btn btn-sm btn-normal" :disabled="processing" :aria-label="`${$t('stopStack')} ${service.name}`" @click="runService('stopService', service.name)">{{ $t("stopStack") }}</button>
                            <button class="btn btn-sm btn-normal" :disabled="processing" :aria-label="`${$t('restartStack')} ${service.name}`" @click="runService('restartService', service.name)">{{ $t("restartStack") }}</button>
                            <button v-if="service.running" class="btn btn-sm btn-normal" :aria-label="`${$t('openShell')} ${service.name}`" @click="openShell(service.name)">
                                <font-awesome-icon icon="terminal" class="me-1" />{{ $t("openShell") }}
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>

            <p v-else-if="!processing" class="faint">{{ $t("noServicesInFile") }}</p>

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
            /** Разобранный compose с подставленными переменными окружения */
            config: {},
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
    },
    unmounted() {
        clearTimeout(this.statusTimer);
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
                }

                clearTimeout(this.statusTimer);
                this.statusTimer = setTimeout(this.requestServiceStatus, STATUS_INTERVAL_MS);
            });
        },

        /**
         * Действие над стеком одним событием агента
         * @param {string} event Имя события
         * @returns {void}
         */
        run(event) {
            this.processing = true;
            this.$root.emitAgent(this.endpoint, event, this.stackName, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
                this.requestServiceStatus();
            });
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

        stateClass(service) {
            if (service.attention) {
                return "bg-warning";
            }
            return service.running ? "bg-primary" : "bg-secondary";
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
    gap: var(--gap-lg);
}

.head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    .identity {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
    }

    h1 {
        font-size: 24px;
        margin: 0;
        overflow-wrap: anywhere;
    }

    .agent {
        color: var(--text-faint);
        font-size: var(--text-sm);
    }

    .actions {
        display: flex;
        align-items: center;
        gap: 6px;
    }
}

.urls {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    a {
        font-family: var(--font-mono);
        font-size: var(--text-sm);
        border: 1px solid var(--line-control);
        border-radius: var(--radius-chip);
        padding: 2px 8px;
        text-decoration: none;
    }
}

.attention {
    border: 1px solid color-mix(in srgb, var(--state-attention) 45%, transparent);
    background-color: color-mix(in srgb, var(--state-attention) 8%, transparent);
    border-radius: var(--radius-panel);
    padding: 10px 12px;
    color: var(--text-strong);

    .reason {
        overflow-wrap: anywhere;
    }

    .btn-link {
        background: none;
        border: 0;
        padding: 0 0 0 8px;
        color: var(--accent-text);
        text-decoration: underline;
    }

    .rest {
        margin: 6px 0 0;
        padding-left: 24px;
    }
}

.services {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);

    th, td {
        text-align: left;
        padding: 8px 10px;
        border-bottom: 1px solid var(--line-hair);
        vertical-align: middle;
    }

    thead th {
        color: var(--text-faint);
        font-weight: 500;
        white-space: nowrap;
    }

    .name {
        font-weight: 600;
    }

    .image {
        font-family: var(--font-mono);
        overflow-wrap: anywhere;
    }

    .ports a {
        font-family: var(--font-mono);
        margin-right: 8px;
    }

    .row-actions {
        text-align: right;
        white-space: nowrap;

        > * {
            margin-left: 4px;
        }
    }
}

.faint {
    color: var(--text-faint);
}

.links {
    .summary {
        background: none;
        border: 0;
        padding: 0;
        color: var(--text-faint);
        font-size: var(--text-sm);
        text-align: left;
    }

    .details {
        display: grid;
        grid-template-columns: minmax(120px, max-content) 1fr;
        gap: 4px 16px;
        margin: 10px 0 0;
        font-size: var(--text-sm);

        dt {
            color: var(--text-faint);
            font-weight: 500;
        }

        dd {
            margin: 0;
            overflow-wrap: anywhere;
        }
    }
}

@media (max-width: 700px) {
    .services {
        .image, .ports {
            display: none;
        }
    }
}
</style>
