<template>
    <!-- Сервис - строка списка внутри панели контейнеров, а не карточка в карточке:
         имя со значком и образ слева, действия справа, настройки раскрываются под строкой -->
    <div class="service">
        <div class="service-head">
            <div class="service-ident">
                <h3 class="service-name"><InterfaceIcon name="box" />{{ name }}</h3>
                <div class="image">
                    <span>{{ imageName }}:</span><span class="tag">{{ imageTag }}</span>
                </div>
                <div v-if="!isEditMode" class="service-state">
                    <StateChip :state="serviceState" :label="statusLabel" :attention="needsAttention" />

                    <a v-for="port in (envsubstService.ports ?? [])" :key="port" class="port-link" :href="parsePort(port).url" target="_blank">
                        <span class="port-chip">{{ parsePort(port).display }}</span>
                    </a>

                    <ul v-if="instances.length > 0" class="instance-list">
                        <li v-for="instance in instances" :key="instance.name">
                            <span class="instance-name">{{ instance.name || $t("unknown") }}</span>
                            <StateChip :state="instanceState(instance)" :label="instanceLabel(instance)" :attention="!!instance.issue" />
                            <span v-if="instance.issue" class="issue">{{ instanceIssueText(instance) }}</span>
                        </li>
                    </ul>
                </div>
            </div>

            <div class="service-actions">
                <!-- В режиме правки у строки два действия: раскрыть настройки и удалить.
                     Удаление не кричит: слово красное, кнопка обычная -->
                <template v-if="isEditMode">
                    <button class="btn btn-sm btn-normal" :aria-expanded="String(showConfig)" @click="showConfig = !showConfig">
                        <font-awesome-icon icon="edit" />{{ $t("Edit") }}
                    </button>
                    <button class="btn btn-sm btn-normal btn-danger-text" @click="remove">
                        <font-awesome-icon icon="trash" />{{ $t("deleteContainer") }}
                    </button>
                </template>
                <div v-else class="btn-group" role="group">
                    <router-link v-if="hasRunningInstance" class="btn btn-sm btn-normal" :to="terminalRouteLink">
                        <font-awesome-icon icon="terminal" />Bash
                    </router-link>
                    <button
                        v-if="serviceCount > 1 && !hasRunningInstance"
                        class="btn btn-sm btn-primary"
                        :disabled="processing"
                        @click="startService"
                    >
                        <font-awesome-icon icon="play" />{{ $t("startStack") }}
                    </button>
                    <button
                        v-if="serviceCount > 1 && hasRunningInstance"
                        class="btn btn-sm btn-normal"
                        :disabled="processing"
                        @click="restartService"
                    >
                        <font-awesome-icon icon="rotate" />{{ $t("restartStack") }}
                    </button>
                    <button
                        v-if="serviceCount > 1 && hasRunningInstance"
                        class="btn btn-sm btn-normal"
                        :disabled="processing"
                        @click="stopService"
                    >
                        <font-awesome-icon icon="stop" />{{ $t("stopStack") }}
                    </button>
                </div>
            </div>
        </div>

        <div v-if="!isEditMode && statsInstances.length > 0" class="service-stats">
            <div class="stats-line">
                <template v-if="!expandedStats">
                    <span class="stats">{{ $t('CPU') }}: {{ statsInstances[0].CPUPerc }}</span>
                    <span class="stats">{{ $t('memoryAbbreviated') }}: {{ statsInstances[0].MemUsage }}</span>
                </template>
                <button class="btn btn-sm btn-normal ms-auto" :aria-expanded="String(expandedStats)" @click="expandedStats = !expandedStats">
                    <font-awesome-icon :icon="expandedStats ? 'chevron-up' : 'chevron-down'" />
                </button>
            </div>
            <transition name="slide-fade" appear>
                <div v-if="expandedStats" class="stats-expanded">
                    <DockerStat
                        v-for="stat in statsInstances"
                        :key="stat.Name"
                        :stat="stat"
                    />
                </div>
            </transition>
        </div>

        <transition name="slide-fade" appear>
            <!-- Настройки сервиса - обычная колонка полей системы: подпись над
                 полем, пояснение под ним, один шаг между полями -->
            <div v-if="isEditMode && showConfig" class="config form-stack">
                <div class="field">
                    <label :for="`service-image-${uid}`" class="form-label">{{ $t("dockerImage") }}</label>
                    <input :id="`service-image-${uid}`" v-model="service.image" class="form-control" list="image-datalist" />
                    <datalist id="image-datalist">
                        <option value="louislam/uptime-kuma:1" />
                    </datalist>
                </div>

                <div class="field">
                    <span class="form-label">{{ $t("port", 2) }}</span>
                    <ArrayInput name="ports" :display-name="$t('port')" placeholder="HOST:CONTAINER" />
                </div>

                <div class="field">
                    <span class="form-label">{{ $t("volume", 2) }}</span>
                    <ArrayInput name="volumes" :display-name="$t('volume')" placeholder="HOST:CONTAINER" />
                </div>

                <div class="field">
                    <label :for="`service-restart-${uid}`" class="form-label">{{ $t("restartPolicy") }}</label>
                    <select :id="`service-restart-${uid}`" v-model="service.restart" class="form-select">
                        <option value="always">{{ $t("restartPolicyAlways") }}</option>
                        <option value="unless-stopped">{{ $t("restartPolicyUnlessStopped") }}</option>
                        <option value="on-failure">{{ $t("restartPolicyOnFailure") }}</option>
                        <option value="no">{{ $t("restartPolicyNo") }}</option>
                    </select>
                </div>

                <div class="field">
                    <span class="form-label">{{ $t("environmentVariable", 2) }}</span>
                    <ArrayInput name="environment" :display-name="$t('environmentVariable')" placeholder="KEY=VALUE" />
                </div>

                <div class="field">
                    <span class="form-label">{{ $t("network", 2) }}</span>
                    <p v-if="networkList.length === 0 && service.networks && service.networks.length > 0" class="form-text attention">
                        {{ $t("NoNetworksAvailable") }}
                    </p>
                    <ArraySelect name="networks" :display-name="$t('network')" placeholder="Network Name" :options="networkList" />
                </div>

                <div class="field">
                    <span class="form-label">{{ $t("dependsOn") }}</span>
                    <ArrayInput name="depends_on" :display-name="$t('dependsOn')" :placeholder="$t(`containerName`)" />
                </div>
            </div>
        </transition>
    </div>
</template>

<script>
import { defineComponent } from "vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { parseDockerPort } from "../../../common/util-common";
import DockerStat from "./DockerStat.vue";
import StateChip from "./StateChip.vue";
import InterfaceIcon from "./InterfaceIcon.vue";

export default defineComponent({
    components: {
        InterfaceIcon,
        FontAwesomeIcon,
        DockerStat,
        StateChip,
    },
    props: {
        name: {
            type: String,
            required: true,
        },
        isEditMode: {
            type: Boolean,
            default: false,
        },
        first: {
            type: Boolean,
            default: false,
        },
        serviceStatus: {
            type: Object,
            default: null,
        },
        dockerStats: {
            type: Object,
            default: null
        },
        /** True while the page runs a stack operation, disables the action buttons */
        processing: {
            type: Boolean,
            default: false,
        }
    },
    emits: [
        "start-service",
        "stop-service",
        "restart-service"
    ],
    data() {
        return {
            showConfig: false,
            expandedStats: false,
        };
    },
    computed: {

        /**
         * Устойчивый хвост для id полей: подписи настроек должны указывать на
         * поле своего сервиса, а сервисов на странице несколько
         * @returns {string} Имя сервиса, пригодное для id
         */
        uid() {
            return this.name.replace(/[^a-zA-Z0-9_-]/g, "-");
        },

        networkList() {
            let list = [];
            for (const networkName in this.jsonObject.networks) {
                list.push(networkName);
            }
            return list;
        },

        /**
         * Состояние сервиса именем системы: синий означает только интерактив,
         * поэтому "работает" - это running, а не primary.
         * @returns {string} Имя состояния для чипа
         */
        serviceState() {
            if (this.needsAttention) {
                return "attention";
            }
            if (this.hasRunningInstance) {
                return "running";
            }
            return "stopped";
        },

        terminalRouteLink() {
            if (this.endpoint) {
                return {
                    name: "containerTerminalEndpoint",
                    params: {
                        endpoint: this.endpoint,
                        stackName: this.stackName,
                        serviceName: this.name,
                        type: "bash",
                    },
                };
            } else {
                return {
                    name: "containerTerminal",
                    params: {
                        stackName: this.stackName,
                        serviceName: this.name,
                        type: "bash",
                    },
                };
            }
        },

        endpoint() {
            return this.$parent.$parent.endpoint;
        },

        stack() {
            return this.$parent.$parent.stack;
        },

        stackName() {
            return this.$parent.$parent.stack.name;
        },

        service() {
            if (!this.jsonObject.services[this.name]) {
                return {};
            }
            return this.jsonObject.services[this.name];
        },

        serviceCount() {
            return Object.keys(this.jsonObject.services).length;
        },

        jsonObject() {
            return this.$parent.$parent.jsonConfig;
        },

        envsubstJSONConfig() {
            return this.$parent.$parent.envsubstJSONConfig;
        },

        envsubstService() {
            if (!this.envsubstJSONConfig.services[this.name]) {
                return {};
            }
            return this.envsubstJSONConfig.services[this.name];
        },

        imageName() {
            if (this.envsubstService.image) {
                return this.envsubstService.image.split(":")[0];
            } else {
                return "";
            }
        },

        imageTag() {
            if (this.envsubstService.image) {
                let tag = this.envsubstService.image.split(":")[1];

                if (tag) {
                    return tag;
                } else {
                    return "latest";
                }
            } else {
                return "";
            }
        },
        statsInstances() {
            return this.instances
                .map(instance => this.dockerStats[instance.name])
                .filter(stat => !!stat)
                .sort((a, b) => a.Name.localeCompare(b.Name));
        },

        /**
         * Every container of this service, typed by the backend
         */
        instances() {
            if (!Array.isArray(this.serviceStatus)) {
                return [];
            }
            return this.serviceStatus;
        },

        hasRunningInstance() {
            return this.instances.some(instance => instance.state === "running");
        },

        /**
         * Whether at least one instance needs attention, which never means "inactive"
         */
        needsAttention() {
            return this.instances.some(instance => !!instance.issue);
        },

        /**
         * Service level label: the instance state when they agree, otherwise a mixed marker
         */
        statusLabel() {
            if (this.instances.length === 0) {
                return this.$t("unknown");
            }

            const labels = new Set(this.instances.map(instance => this.instanceLabel(instance)));
            if (labels.size === 1) {
                return [ ...labels ][0];
            }
            return this.$t("mixedState");
        },
    },
    mounted() {
        if (this.first) {
            //this.showConfig = true;
        }
    },
    methods: {
        /**
         * Human readable state of one instance
         * @param {object} instance Typed instance status
         * @returns {string} Label
         */
        instanceLabel(instance) {
            if (instance.health) {
                return this.$t(instance.health);
            }
            if (!instance.state) {
                return this.$t("unknown");
            }
            return this.$t(instance.state);
        },

        /**
         * Состояние одного контейнера именем системы
         * @param {object} instance Typed instance status
         * @returns {string} Имя состояния для чипа
         */
        instanceState(instance) {
            if (instance.issue) {
                return "attention";
            }
            if (instance.state === "running") {
                return "running";
            }
            return "stopped";
        },

        /**
         * Explain why an instance needs attention
         * @param {object} instance Typed instance status
         * @returns {string} Reason text
         */
        instanceIssueText(instance) {
            if (!instance.issue) {
                return "";
            }
            if (instance.exitCode !== null && (instance.issue === "workerFailed" || instance.issue === "serviceFailed")) {
                return `${this.$t(instance.issue)} (${instance.exitCode})`;
            }
            return this.$t(instance.issue);
        },

        parsePort(port) {
            if (this.stack.endpoint) {
                return parseDockerPort(port, this.stack.primaryHostname);
            } else {
                let hostname = this.$root.info.primaryHostname || location.hostname;
                return parseDockerPort(port, hostname);
            }
        },
        remove() {
            delete this.jsonObject.services[this.name];
        },
        startService() {
            this.$emit("start-service", this.name);
        },
        stopService() {
            this.$emit("stop-service", this.name);
        },
        restartService() {
            this.$emit("restart-service", this.name);
        }

    }
});
</script>

<style scoped lang="scss">
// Строка сервиса: соседние строки разделяет тонкая линия, отступ у всех один -
// тот же, что у тела панели, поэтому список читается как одно целое
.service {
    padding: var(--gap-md);

    & + & {
        border-top: 1px solid var(--line-hair);
    }
}

.service-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--gap-sm) var(--gap-md);
}

.service-ident {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
    min-width: 0;
}

.service-name {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-sm);
    margin: 0;
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
    color: var(--text-strong);
    overflow-wrap: anywhere;

    > svg {
        flex: none;
        color: var(--text-muted);
    }
}

.image {
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;

    .tag {
        color: var(--text-strong);
    }
}

.service-state {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-xs) var(--gap-sm);
}

.service-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-sm);
    margin-left: auto;
}

.service-stats {
    margin-top: var(--gap-sm);
}

.stats-line {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
}

.stats {
    font-size: var(--text-sm);
    color: var(--text-muted);
}

// Настройки раскрываются под строкой и отделены от нее линией, а не второй рамкой
// Настройки раскрываются под строкой сервиса, поэтому отделены от нее линией
.config {
    max-width: none;
    margin-top: var(--gap-md);
    padding-top: var(--gap-md);
    border-top: 1px solid var(--line-hair);
}

// Предупреждение внутри поля говорит цветом состояния, а не своей плашкой
.form-text.attention {
    color: var(--state-attention);
}

.stats-expanded {
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    margin-top: var(--gap-sm);
}

.form-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.instance-list {
    list-style: none;
    padding: 0;
    margin: 0;
    width: 100%;
    font-size: var(--text-xs);

    // Имя экземпляра, его состояние и причина стоят в строку с одним шагом
    li {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--gap-xs);
    }

    .instance-name {
        opacity: 0.8;
    }

    .issue {
        opacity: 0.8;
    }
}

// Порт - ссылка, а не состояние: нейтральная поверхность и видимый фокус.
.port-link {
    display: inline-block;
    text-decoration: none;
    border-radius: var(--radius-pill);

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.port-chip {
    display: inline-block;
    padding: 1px var(--gap-sm);
    border-radius: var(--radius-pill);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
    line-height: var(--line-sm);
    color: var(--accent-text);
    background-color: var(--surface-raised);
    border: 1px solid var(--line-hair);
}
</style>
