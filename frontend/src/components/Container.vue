<template>
    <div class="shadow-box big-padding mb-3 container">
        <div class="row">
            <div class="col-5">
                <h4>{{ name }}</h4>
                <div class="image mb-2">
                    <span class="me-1">{{ imageName }}:</span><span class="tag">{{ imageTag }}</span>
                </div>
                <div v-if="!isEditMode">
                    <span class="badge me-1" :class="bgStyle">
                        <font-awesome-icon v-if="needsAttention" icon="triangle-exclamation" class="me-1" />{{ statusLabel }}
                    </span>

                    <a v-for="port in (envsubstService.ports ?? [])" :key="port" :href="parsePort(port).url" target="_blank">
                        <span class="badge me-1 bg-secondary">{{ parsePort(port).display }}</span>
                    </a>

                    <ul v-if="instances.length > 0" class="instance-list mt-2">
                        <li v-for="instance in instances" :key="instance.name">
                            <span class="instance-name">{{ instance.name || $t("unknown") }}</span>
                            <span class="badge ms-1" :class="instanceStyle(instance)">{{ instanceLabel(instance) }}</span>
                            <span v-if="instance.issue" class="issue ms-1">{{ instanceIssueText(instance) }}</span>
                        </li>
                    </ul>
                </div>
            </div>
            <div class="col-7">
                <div class="function">
                    <div class="btn-group me-2" role="group">
                        <router-link v-if="!isEditMode && hasRunningInstance" class="btn btn-normal" :to="terminalRouteLink" disabled="">
                            <font-awesome-icon icon="terminal" />
                            Bash
                        </router-link>
                        <button
                            v-if="serviceCount > 1 && !isEditMode && !hasRunningInstance"
                            class="btn btn-primary"
                            :disabled="processing"
                            @click="startService"
                        >
                            <font-awesome-icon icon="play" class="me-1" />
                            {{ $t("startStack") }}
                        </button>
                        <button
                            v-if="serviceCount > 1 && !isEditMode && hasRunningInstance"
                            class="btn btn-normal"
                            :disabled="processing"
                            @click="restartService"
                        >
                            <font-awesome-icon icon="rotate" class="me-1" />
                            {{ $t("restartStack") }}
                        </button>
                        <button
                            v-if="serviceCount > 1 && !isEditMode && hasRunningInstance"
                            class="btn btn-normal"
                            :disabled="processing"
                            @click="stopService"
                        >
                            <font-awesome-icon icon="stop" class="me-1" />
                            {{ $t("stopStack") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <div v-if="isEditMode" class="mt-2">
            <button class="btn btn-normal me-2" @click="showConfig = !showConfig">
                <font-awesome-icon icon="edit" />
                {{ $t("Edit") }}
            </button>
            <button v-if="false" class="btn btn-normal me-2">Rename</button>
            <button class="btn btn-danger me-2" @click="remove">
                <font-awesome-icon icon="trash" />
                {{ $t("deleteContainer") }}
            </button>
        </div>
        <div v-else-if="statsInstances.length > 0" class="mt-2">
            <div class="d-flex align-items-center gap-3">
                <template v-if="!expandedStats">
                    <div class="stats">
                        {{ $t('CPU') }}: {{ statsInstances[0].CPUPerc }}
                    </div>
                    <div class="stats">
                        {{ $t('memoryAbbreviated') }}: {{ statsInstances[0].MemUsage }}
                    </div>
                </template>
                <div class="d-flex flex-grow-1 justify-content-end">
                    <button class="btn btn-sm btn-normal" @click="expandedStats = !expandedStats">
                        <font-awesome-icon :icon="expandedStats ? 'chevron-up' : 'chevron-down'" />
                    </button>
                </div>
            </div>
            <transition name="slide-fade" appear>
                <div v-if="expandedStats" class="d-flex flex-column gap-3 mt-2">
                    <DockerStat
                        v-for="stat in statsInstances"
                        :key="stat.Name"
                        :stat="stat"
                    />
                </div>
            </transition>
        </div>

        <transition name="slide-fade" appear>
            <div v-if="isEditMode && showConfig" class="config mt-3">
                <!-- Image -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("dockerImage") }}
                    </label>
                    <div class="input-group mb-3">
                        <input
                            v-model="service.image"
                            class="form-control"
                            list="image-datalist"
                        />
                    </div>

                    <!-- TODO: Search online: https://hub.docker.com/api/content/v1/products/search?q=louislam%2Fuptime&source=community&page=1&page_size=4 -->
                    <datalist id="image-datalist">
                        <option value="louislam/uptime-kuma:1" />
                    </datalist>
                    <div class="form-text"></div>
                </div>

                <!-- Ports -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("port", 2) }}
                    </label>
                    <ArrayInput name="ports" :display-name="$t('port')" placeholder="HOST:CONTAINER" />
                </div>

                <!-- Volumes -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("volume", 2) }}
                    </label>
                    <ArrayInput name="volumes" :display-name="$t('volume')" placeholder="HOST:CONTAINER" />
                </div>

                <!-- Restart Policy -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("restartPolicy") }}
                    </label>
                    <select v-model="service.restart" class="form-select">
                        <option value="always">{{ $t("restartPolicyAlways") }}</option>
                        <option value="unless-stopped">{{ $t("restartPolicyUnlessStopped") }}</option>
                        <option value="on-failure">{{ $t("restartPolicyOnFailure") }}</option>
                        <option value="no">{{ $t("restartPolicyNo") }}</option>
                    </select>
                </div>

                <!-- Environment Variables -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("environmentVariable", 2) }}
                    </label>
                    <ArrayInput name="environment" :display-name="$t('environmentVariable')" placeholder="KEY=VALUE" />
                </div>

                <!-- Container Name -->
                <div v-if="false" class="mb-4">
                    <label class="form-label">
                        {{ $t("containerName") }}
                    </label>
                    <div class="input-group mb-3">
                        <input
                            v-model="service.container_name"
                            class="form-control"
                        />
                    </div>
                    <div class="form-text"></div>
                </div>

                <!-- Network -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("network", 2) }}
                    </label>

                    <div v-if="networkList.length === 0 && service.networks && service.networks.length > 0" class="text-warning mb-3">
                        {{ $t("NoNetworksAvailable") }}
                    </div>

                    <ArraySelect name="networks" :display-name="$t('network')" placeholder="Network Name" :options="networkList" />
                </div>

                <!-- Depends on -->
                <div class="mb-4">
                    <label class="form-label">
                        {{ $t("dependsOn") }}
                    </label>
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

export default defineComponent({
    components: {
        FontAwesomeIcon,
        DockerStat
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

        networkList() {
            let list = [];
            for (const networkName in this.jsonObject.networks) {
                list.push(networkName);
            }
            return list;
        },

        bgStyle() {
            if (this.needsAttention) {
                return "bg-warning";
            }
            if (this.hasRunningInstance) {
                return "bg-primary";
            }
            return "bg-secondary";
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
         * Badge style of one instance
         * @param {object} instance Typed instance status
         * @returns {string} Bootstrap class
         */
        instanceStyle(instance) {
            if (instance.issue) {
                return "bg-warning";
            }
            if (instance.state === "running") {
                return "bg-primary";
            }
            return "bg-secondary";
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
.instance-list {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 0.8rem;

    .instance-name {
        opacity: 0.8;
    }

    .issue {
        opacity: 0.8;
    }
}

@import "../styles/vars";

.container {
    .image {
        font-size: 0.8rem;
        color: #6c757d;
        .tag {
            color: #33383b;
        }
    }

    .function {
        align-content: center;
        display: flex;
        height: 100%;
        width: 100%;
        align-items: center;
        justify-content: end;
    }

    .stats {
        font-size: 0.8rem;
        color: #6c757d;
    }
}
</style>
