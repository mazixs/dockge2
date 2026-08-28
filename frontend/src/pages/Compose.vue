<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 v-if="isAdd" class="mb-3">{{ $t("compose") }}</h1>
            <h1 v-else class="mb-3">
                <!-- Инспектор остаётся тем, откуда пришли: имя стека ведёт назад -->
                <router-link :to="url" class="back">{{ stack.name }}</router-link>
                <span class="file-name">/ {{ stack.composeFileName }}</span>
                <span v-if="$root.agentCount > 1 && endpoint !== ''" class="agent-name">
                    ({{ endpointDisplay }})
                </span>
            </h1>

            <div v-if="stack.isManagedByDockge" class="mb-3">
                <!-- Здесь только правка файла: остановить, обновить и удалить можно из инспектора -->
                <button v-if="isEditMode" class="btn btn-primary me-2" :disabled="processing" @click="deployStack">
                    <font-awesome-icon icon="rocket" class="me-1" />
                    {{ $t("deployStack") }}
                </button>

                <button v-if="isEditMode" class="btn btn-normal me-2" :disabled="processing" @click="saveStack">
                    <font-awesome-icon icon="save" class="me-1" />
                    {{ $t("saveStackDraft") }}
                </button>

                <button v-if="!isEditMode" class="btn btn-primary me-2" :disabled="processing" @click="enableEditMode">
                    <font-awesome-icon icon="pen" class="me-1" />
                    {{ $t("editStack") }}
                </button>

                <button v-if="isEditMode && !isAdd" class="btn btn-normal" :disabled="processing" @click="discardStack">{{ $t("discardStack") }}</button>
            </div>

            <!-- Progress Terminal -->
            <transition name="slide-fade" appear>
                <Terminal
                    v-show="showProgressTerminal"
                    ref="progressTerminal"
                    class="mb-3 terminal"
                    :name="terminalName"
                    :endpoint="endpoint"
                    :rows="progressTerminalRows"
                    @has-data="showProgressTerminal = true; submitted = true;"
                ></Terminal>
            </transition>

            <div v-if="stack.isManagedByDockge" class="row">
                <div class="col-lg-6">
                    <!-- General -->
                    <div v-if="isAdd">
                        <h4 class="mb-3">{{ $t("general") }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <!-- Stack Name -->
                            <div>
                                <label for="name" class="form-label">{{ $t("stackName") }}</label>
                                <input id="name" v-model="stack.name" type="text" class="form-control" required @blur="stackNameToLowercase">
                                <div class="form-text">{{ $t("Lowercase only") }}</div>
                            </div>

                            <!-- Endpoint -->
                            <div class="mt-3">
                                <label for="name" class="form-label">{{ $t("dockgeAgent") }}</label>
                                <select v-model="stack.endpoint" class="form-select">
                                    <option v-for="(agent, agentEndpoint) in $root.agentList" :key="agentEndpoint" :value="agentEndpoint" :disabled="$root.agentStatusList[agentEndpoint] != 'online'">
                                        ({{ $root.agentStatusList[agentEndpoint] }}) {{ (agent.name !== '') ? agent.name : agent.url || $t("Current") }}
                                    </option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <h4 class="mb-3">{{ stack.composeFileName }}</h4>

                    <!-- YAML editor -->
                    <div class="shadow-box mb-3 editor-box" :class="{'edit-mode' : isEditMode}">
                        <code-mirror
                            ref="editor"
                            v-model="stack.composeYAML"
                            :extensions="extensions"
                            minimal
                            wrap
                            dark
                            tab
                            :disabled="!isEditMode"
                            :hasFocus="editorFocus"
                            @change="yamlCodeChange"
                        />
                    </div>
                    <div v-if="isEditMode" class="mb-3">
                        {{ yamlError }}
                    </div>

                    <!-- A file the structured editor cannot rebuild stays in text mode -->
                    <div v-if="isEditMode && composeAnalysis && !structuredEditsEnabled && unsupportedConstructs.length > 0" class="alert alert-warning" role="alert">
                        <font-awesome-icon icon="triangle-exclamation" class="me-1" />
                        {{ $t("textModeOnly", [ unsupportedConstructs.join(", ") ]) }}
                    </div>

                    <!-- ENV editor -->
                    <div v-if="isEditMode">
                        <h4 class="mb-3">{{ activeEnvFileName }}</h4>
                        <div class="shadow-box mb-3 editor-box" :class="{'edit-mode' : isEditMode}">
                            <code-mirror
                                ref="editor"
                                v-model="stack.composeENV"
                                :extensions="extensionsEnv"
                                minimal
                                wrap
                                dark
                                tab
                                :disabled="!isEditMode"
                                :hasFocus="editorFocus"
                                @change="yamlCodeChange"
                            />
                        </div>
                    </div>

                    <!-- Containers -->
                    <h4 v-if="isEditMode" class="mb-3">{{ $t("container", 2) }}</h4>

                    <div v-if="isEditMode && structuredEditsEnabled" class="input-group mb-3">
                        <input
                            v-model="newContainerName"
                            :placeholder="$t(`New Container Name...`)"
                            class="form-control"
                            @keyup.enter="addContainer"
                        />
                        <button class="btn btn-primary" @click="addContainer">
                            {{ $t("addContainer") }}
                        </button>
                    </div>

                    <div v-if="isEditMode" ref="containerList">
                        <Container
                            v-for="(service, name) in jsonConfig.services"
                            :key="name"
                            :name="name"
                            :is-edit-mode="isEditMode && structuredEditsEnabled"
                            :first="name === Object.keys(jsonConfig.services)[0]"
                            :serviceStatus="serviceStatusList[name]"
                            :dockerStats="dockerStats"
                            :processing="processing"
                            @start-service="startService"
                            @stop-service="stopService"
                            @restart-service="restartService"
                        />
                    </div>

                    <button v-if="false && isEditMode && jsonConfig.services && Object.keys(jsonConfig.services).length > 0" class="btn btn-normal mb-3" @click="addContainer">{{ $t("addContainer") }}</button>

                    <!-- General -->
                    <div v-if="isEditMode && structuredEditsEnabled">
                        <h4 class="mb-3">{{ $t("extra") }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <!-- URLs -->
                            <div class="mb-4">
                                <label class="form-label">
                                    {{ $t("url", 2) }}
                                </label>
                                <ArrayInput name="urls" :display-name="$t('url')" placeholder="https://" object-type="x-dockge" />
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-lg-6">
                    <!-- Files of the stack directory -->
                    <div v-if="!isAdd && stack.isManagedByDockge && fileInventory">
                        <h4 class="mb-3">{{ $t("stackFiles") }}</h4>
                        <StackFilesEditor
                            :inventory="fileInventory"
                            :disabled="processing"
                            @save="saveFileSelection"
                        />
                    </div>

                    <!-- Compose secrets stored as files -->
                    <div v-if="!isAdd && stack.isManagedByDockge && fileInventory">
                        <h4 class="mb-3">{{ $t("secrets") }}</h4>
                        <SecretEditor
                            :stackName="stack.name"
                            :endpoint="endpoint"
                            :secretFiles="fileInventory.secretFiles"
                            :services="serviceNames"
                            :disabled="processing"
                            @updated="onSecretsUpdated"
                        />
                    </div>

                    <div v-if="isEditMode && structuredEditsEnabled">
                        <!-- Volumes -->
                        <div v-if="false">
                            <h4 class="mb-3">{{ $t("volume", 2) }}</h4>
                            <div class="shadow-box big-padding mb-3">
                            </div>
                        </div>

                        <!-- Networks -->
                        <h4 class="mb-3">{{ $t("network", 2) }}</h4>
                        <div class="shadow-box big-padding mb-3">
                            <NetworkInput />
                        </div>
                    </div>

                    <!-- <div class="shadow-box big-padding mb-3">
                        <div class="mb-3">
                            <label for="name" class="form-label"> Search Templates</label>
                            <input id="name" v-model="name" type="text" class="form-control" placeholder="Search..." required>
                        </div>

                        <prism-editor v-if="false" v-model="yamlConfig" class="yaml-editor" :highlight="highlighter" line-numbers @input="yamlCodeChange"></prism-editor>
                    </div>-->
                </div>
            </div>

            <div v-if="!stack.isManagedByDockge && !processing">
                {{ $t("stackNotManagedByDockgeMsg") }}
            </div>
        </div>
    </transition>
</template>

<script>
import CodeMirror from "vue-codemirror6";
import { yaml } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { oneDark as editorTheme } from "@codemirror/theme-one-dark";
import { lineNumbers, EditorView } from "@codemirror/view";
import { parseDocument } from "yaml";

import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import {
    envsubstYAML,
    getComposeTerminalName,
    PROGRESS_TERMINAL_ROWS
} from "../../../common/util-common";
import { analyseComposeSource, applyStructuredEdit, canEditStructurally } from "../../../common/compose-editor";
import NetworkInput from "../components/NetworkInput.vue";
import StackFilesEditor from "../components/StackFilesEditor.vue";
import SecretEditor from "../components/SecretEditor.vue";
import dotenv from "dotenv";
import { ref } from "vue";

const template = `
services:
  nginx:
    image: nginx:latest
    restart: unless-stopped
    ports:
      - "8080:80"
`;
const envDefault = "# VARIABLE=value #comment";

let yamlErrorTimeout = null;

let serviceStatusTimeout = null;
let dockerStatsTimeout = null;

export default {
    components: {
        NetworkInput,
        FontAwesomeIcon,
        CodeMirror,
        StackFilesEditor,
        SecretEditor,
    },
    beforeRouteUpdate(to, from, next) {
        this.exitConfirm(next);
    },
    beforeRouteLeave(to, from, next) {
        this.exitConfirm(next);
    },
    setup() {
        const editorFocus = ref(false);

        const focusEffectHandler = (state, focusing) => {
            editorFocus.value = focusing;
            return null;
        };

        const extensions = [
            editorTheme,
            yaml(),
            lineNumbers(),
            EditorView.focusChangeEffect.of(focusEffectHandler)
        ];

        const extensionsEnv = [
            editorTheme,
            python(),
            lineNumbers(),
            EditorView.focusChangeEffect.of(focusEffectHandler)
        ];

        return { extensions,
            extensionsEnv,
            editorFocus };
    },
    yamlDoc: null,  // For keeping the yaml comments
    data() {
        return {
            jsonConfig: {},
            envsubstJSONConfig: {},
            yamlError: "",
            processing: true,
            showProgressTerminal: false,
            progressTerminalRows: PROGRESS_TERMINAL_ROWS,
            stack: {

            },
            serviceStatusList: {},
            fileInventory: null,
            composeAnalysis: null,
            /** Text the current model and analysis were built from */
            analysedSource: "",
            /** Whether the compose file had a top level networks key when it was loaded */
            sourceHadNetworks: false,
            /** True while the model is filled from the server or the text editor */
            applyingExternal: false,
            /** Set when the user removed the last network by hand */
            explicitNetworkRemoval: false,
            dockerStats: {},
            isEditMode: false,
            submitted: false,
            newContainerName: "",
            stopServiceStatusTimeout: false,
            stopDockerStatsTimeout: false,
        };
    },
    computed: {
        endpointDisplay() {
            return this.$root.endpointDisplayFunction(this.endpoint);
        },

        urls() {
            if (!this.envsubstJSONConfig["x-dockge"] || !this.envsubstJSONConfig["x-dockge"].urls || !Array.isArray(this.envsubstJSONConfig["x-dockge"].urls)) {
                return [];
            }

            let urls = [];
            for (const url of this.envsubstJSONConfig["x-dockge"].urls) {
                let display;
                try {
                    let obj = new URL(url);
                    let pathname = obj.pathname;
                    if (pathname === "/") {
                        pathname = "";
                    }
                    display = obj.host + pathname + obj.search;
                } catch {
                    display = url;
                }

                urls.push({
                    display,
                    url,
                });
            }
            return urls;
        },

        isAdd() {
            return this.$route.path === "/compose" && !this.submitted;
        },

        /**
         * Get the stack from the global stack list, because it may contain more real-time data like status
         * @return {*}
         */
        globalStack() {
            return this.$root.completeStackList[this.stack.name + "_" + this.endpoint];
        },

        /**
         * Whether the structured editor may write the compose file back.
         * Files with include, custom tags, anchors or merge keys stay in text mode.
         * @returns {boolean} True when a structured edit keeps the meaning of the file
         */
        structuredEditsEnabled() {
            if (!this.composeAnalysis || !canEditStructurally(this.composeAnalysis)) {
                return false;
            }

            // The model belongs to the text it was parsed from. If the text moved on
            // (a broken intermediate state, for example) a structured write would
            // silently drop everything the model does not know about.
            return this.analysedSource === this.stack.composeYAML;
        },

        /**
         * Constructs that keep the file in text mode
         * @returns {Array<string>} Reasons
         */
        unsupportedConstructs() {
            return this.composeAnalysis?.unsupported ?? [];
        },

        /**
         * Env file that the editor shows, taken from the stored selection
         * @returns {string} File name
         */
        activeEnvFileName() {
            return this.fileInventory?.config?.activeEnvFileName || ".env";
        },

        /**
         * Services declared in the compose file, used for secret bindings
         * @returns {Array<string>} Service names
         */
        serviceNames() {
            return Object.keys(this.jsonConfig?.services ?? {});
        },

        terminalName() {
            if (!this.stack.name) {
                return "";
            }
            return getComposeTerminalName(this.endpoint, this.stack.name);
        },

        networks() {
            return this.jsonConfig.networks;
        },

        endpoint() {
            return this.stack.endpoint || this.$route.params.endpoint || "";
        },

        /** Куда возвращаться после сохранения: инспектор стека, а не редактор */
        url() {
            if (this.stack.endpoint) {
                return `/stack/${this.stack.name}/${this.stack.endpoint}`;
            } else {
                return `/stack/${this.stack.name}`;
            }
        },
    },
    watch: {
        "stack.composeYAML": {
            handler() {
                if (this.editorFocus) {
                    console.debug("yaml code changed");
                    this.yamlCodeChange();
                }
            },
            deep: true,
        },

        "stack.composeENV": {
            handler() {
                if (this.editorFocus) {
                    console.debug("env code changed");
                    this.yamlCodeChange();
                }
            },
            deep: true,
        },

        jsonConfig: {
            handler() {
                // The text editor is the source of truth while the user types in it
                if (this.editorFocus) {
                    return;
                }

                // Values that came from the server or from the parsed source are not an edit
                if (this.applyingExternal) {
                    return;
                }

                // Viewing a stack must never rewrite its file
                if (!this.isEditMode) {
                    return;
                }

                // A file the editor cannot rebuild stays untouched
                if (!this.structuredEditsEnabled) {
                    return;
                }

                this.writeStructuredEdit();
            },
            deep: true,
        },

        $route(to, from) {

        }
    },
    mounted() {
        if (this.isAdd) {
            this.processing = false;
            this.isEditMode = true;

            let composeYAML;
            let composeENV;

            if (this.$root.composeTemplate) {
                composeYAML = this.$root.composeTemplate;
                this.$root.composeTemplate = "";
            } else {
                composeYAML = template;
            }
            if (this.$root.envTemplate) {
                composeENV = this.$root.envTemplate;
                this.$root.envTemplate = "";
            } else {
                composeENV = envDefault;
            }

            // Default Values
            this.stack = {
                name: "",
                composeYAML,
                composeENV,
                isManagedByDockge: true,
                endpoint: "",
            };

            this.yamlCodeChange();

        } else {
            this.stack.name = this.$route.params.stackName;
            this.loadStack();
        }

        this.requestServiceStatus();
        this.requestDockerStats();
    },
    unmounted() {

    },
    methods: {
        startServiceStatusTimeout() {
            clearTimeout(serviceStatusTimeout);
            serviceStatusTimeout = setTimeout(async () => {
                this.requestServiceStatus();
            }, 5000);
        },

        startDockerStatsTimeout() {
            clearTimeout(dockerStatsTimeout);
            dockerStatsTimeout = setTimeout(async () => {
                this.requestDockerStats();
            }, 5000);
        },

        /**
         * Load which compose, env and secret files this stack uses
         * @returns {void}
         */
        requestStackFiles() {
            if (this.isAdd) {
                return;
            }

            this.$root.emitAgent(this.endpoint, "getStackFiles", this.stack.name, (res) => {
                if (res.ok) {
                    this.fileInventory = res.inventory;
                }
            });
        },

        /**
         * Store a new file selection and reload the stack, because the shown texts may change
         * @param {object} config Selection from the editor
         * @returns {void}
         */
        saveFileSelection(config) {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "setStackFiles", this.stack.name, config, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (!res.ok) {
                    return;
                }

                this.requestStackFiles();

                // Reloading replaces the texts with what is on disk, which would silently
                // discard edits the user has not saved yet
                if (this.isEditMode) {
                    this.$root.toastError(this.$t("reloadNeededAfterFileChange"));
                    return;
                }

                this.loadStack();
            });
        },

        /**
         * Refresh the secret list after an authorised secret action
         * @param {Array<object>} secretFiles New metadata
         * @returns {void}
         */
        onSecretsUpdated(secretFiles) {
            if (this.fileInventory) {
                this.fileInventory.secretFiles = secretFiles;
            }
            this.requestStackFiles();
        },

        requestServiceStatus() {
            // Do not request if it is add mode
            if (this.isAdd) {
                return;
            }

            this.$root.emitAgent(this.endpoint, "serviceStatusList", this.stack.name, (res) => {
                if (res.ok) {
                    this.serviceStatusList = res.serviceStatusList;
                }
                if (!this.stopServiceStatusTimeout) {
                    this.startServiceStatusTimeout();
                }
            });
        },

        requestDockerStats() {
            this.$root.emitAgent(this.endpoint, "dockerStats", (res) => {
                if (res.ok) {
                    this.dockerStats = res.dockerStats;
                }
                if (!this.stopDockerStatsTimeout) {
                    this.startDockerStatsTimeout();
                }
            });
        },

        exitConfirm(next) {
            if (this.isEditMode) {
                if (confirm(this.$t("confirmLeaveStack"))) {
                    this.exitAction();
                    next();
                } else {
                    next(false);
                }
            } else {
                this.exitAction();
                next();
            }
        },

        exitAction() {
            console.log("exitAction");
            this.stopServiceStatusTimeout = true;
            this.stopDockerStatsTimeout = true;
            clearTimeout(serviceStatusTimeout);
            clearTimeout(dockerStatsTimeout);

            // Вывод стека живёт в доке: он сам решает, когда отписаться, поэтому
            // уход с редактора больше не обрывает чужие логи
        },

        bindTerminal() {
            this.$refs.progressTerminal?.bind(this.endpoint, this.terminalName);
        },

        loadStack() {
            this.processing = true;
            this.$root.emitAgent(this.endpoint, "getStack", this.stack.name, (res) => {
                if (res.ok) {
                    this.stack = res.stack;
                    this.yamlCodeChange();

                    // What the file on disk had is the reference for the networks rule
                    this.sourceHadNetworks = this.composeAnalysis?.hasNetworksKey ?? false;
                    this.processing = false;
                    this.bindTerminal();
                    this.requestStackFiles();
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        deployStack() {
            this.processing = true;

            if (!this.jsonConfig.services) {
                this.$root.toastError("No services found in compose.yaml");
                this.processing = false;
                return;
            }

            // Check if services is object
            if (typeof this.jsonConfig.services !== "object") {
                this.$root.toastError("Services must be an object");
                this.processing = false;
                return;
            }

            let serviceNameList = Object.keys(this.jsonConfig.services);

            // Set the stack name if empty, use the first container name
            if (!this.stack.name && serviceNameList.length > 0) {
                let serviceName = serviceNameList[0];
                let service = this.jsonConfig.services[serviceName];

                if (service && service.container_name) {
                    this.stack.name = service.container_name;
                } else {
                    this.stack.name = serviceName;
                }
            }

            this.bindTerminal();

            this.$root.emitAgent(this.stack.endpoint, "deployStack", this.stack.name, this.stack.composeYAML, this.stack.composeENV, this.isAdd, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.isEditMode = false;
                    this.$router.push(this.url);
                }
            });
        },

        saveStack() {
            this.processing = true;

            this.$root.emitAgent(this.stack.endpoint, "saveStack", this.stack.name, this.stack.composeYAML, this.stack.composeENV, this.isAdd, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.isEditMode = false;
                    this.$router.push(this.url);
                }
            });
        },

        discardStack() {
            this.loadStack();
            this.isEditMode = false;
        },

        yamlToJSON(yaml) {
            let doc = parseDocument(yaml);
            if (doc.errors.length > 0) {
                throw doc.errors[0];
            }

            const config = doc.toJS() ?? {};

            // Check data types
            // "services" must be an object
            if (!config.services) {
                config.services = {};
            }

            if (Array.isArray(config.services) || typeof config.services !== "object") {
                throw new Error("Services must be an object");
            }

            return {
                config,
                doc,
            };
        },

        yamlCodeChange() {
            try {
                let { config, doc } = this.yamlToJSON(this.stack.composeYAML);

                this.yamlDoc = doc;
                this.composeAnalysis = analyseComposeSource(this.stack.composeYAML);
                this.analysedSource = this.stack.composeYAML;

                // Filling the model from the source is not a user edit
                this.applyingExternal = true;
                this.jsonConfig = config;
                this.$nextTick(() => {
                    this.applyingExternal = false;
                });

                let env = dotenv.parse(this.stack.composeENV);
                let envYAML = envsubstYAML(this.stack.composeYAML, env);
                this.envsubstJSONConfig = this.yamlToJSON(envYAML).config;

                clearTimeout(yamlErrorTimeout);
                this.yamlError = "";
            } catch (e) {
                clearTimeout(yamlErrorTimeout);

                if (this.yamlError) {
                    this.yamlError = e.message;

                } else {
                    yamlErrorTimeout = setTimeout(() => {
                        this.yamlError = e.message;
                    }, 3000);
                }
            }
        },

        /**
         * Write an explicit structured edit into the compose source.
         * Untouched values keep their formatting, comments and octal notation.
         * @returns {void}
         */
        writeStructuredEdit() {
            const source = this.stack.composeYAML;

            const explicitNetworkRemoval = this.explicitNetworkRemoval;

            // The flag describes this one edit, so it is cleared even if the edit fails
            this.explicitNetworkRemoval = false;

            let next;
            try {
                next = applyStructuredEdit(source, this.jsonConfig, {
                    sourceHadNetworks: this.sourceHadNetworks,
                    explicitNetworkRemoval,
                });
            } catch (e) {
                this.yamlError = e.message;
                return;
            }

            if (next === source) {
                return;
            }

            this.applyingExternal = true;
            this.stack.composeYAML = next;
            this.composeAnalysis = analyseComposeSource(next);
            this.analysedSource = next;
            this.yamlDoc = this.composeAnalysis.doc;
            this.$nextTick(() => {
                this.applyingExternal = false;
            });
        },

        /**
         * Apply a network edit coming from the network editor.
         * An empty result never introduces `networks: {}` on its own.
         * @param {object} networks Networks the user configured
         * @param {object} options Extra flags, `explicitRemoval` when the user deleted the last network
         * @returns {void}
         */
        applyNetworksEdit(networks, options = {}) {
            const cleaned = {};

            for (const [ name, value ] of Object.entries(networks)) {
                if (name.trim() === "") {
                    continue;
                }
                cleaned[name] = value;
            }

            if (Object.keys(cleaned).length === 0) {
                this.explicitNetworkRemoval = options.explicitRemoval === true;
                delete this.jsonConfig.networks;
            } else {
                this.jsonConfig.networks = cleaned;
            }
        },

        enableEditMode() {
            this.isEditMode = true;
        },

        checkYAML() {

        },

        addContainer() {
            this.checkYAML();

            if (this.jsonConfig.services[this.newContainerName]) {
                this.$root.toastError("Container name already exists");
                return;
            }

            if (!this.newContainerName) {
                this.$root.toastError("Container name cannot be empty");
                return;
            }

            this.jsonConfig.services[this.newContainerName] = {
                restart: "unless-stopped",
            };
            this.newContainerName = "";
            let element = this.$refs.containerList.lastElementChild;
            element.scrollIntoView({
                block: "start",
                behavior: "smooth"
            });
        },

        stackNameToLowercase() {
            this.stack.name = this.stack?.name?.toLowerCase();
        },

        startService(serviceName) {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "startService", this.stack.name, serviceName, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestServiceStatus(); // Refresh service status
                }
            });
        },

        stopService(serviceName) {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "stopService", this.stack.name, serviceName, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestServiceStatus(); // Refresh service status
                }
            });
        },

        restartService(serviceName) {
            this.processing = true;

            this.$root.emitAgent(this.endpoint, "restartService", this.stack.name, serviceName, (res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestServiceStatus(); // Refresh service status
                }
            });
        },
    }
};
</script>

<style scoped lang="scss">
// Заголовок страницы и подписи берутся из шкалы кегля, а не из своих чисел:
// иначе редактор набран не тем же голосом, что список и инспектор.
h1 {
    font-size: var(--text-xl);
    font-weight: 600;
    letter-spacing: -.01em;

    .back {
        text-decoration: none;
    }

    .file-name {
        margin-left: var(--gap-sm);
        font-family: var(--font-mono);
        font-size: var(--text-md);
        color: var(--text-faint);
    }
}

h4 {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text-strong);
}

.form-label {
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.form-text {
    font-size: var(--text-xs);
    color: var(--text-faint);
}

.terminal {
    height: 200px;
}

// Панель редактора: тот же радиус, что у остальных панелей, но поверхность
// консольная в обеих темах - подсветка синтаксиса CodeMirror нарисована для
// тёмного фона, и на белом её красные ключи не проходят порог контраста
.editor-box {
    font-family: var(--font-mono);
    font-size: var(--text-base);
    border-radius: var(--radius-panel);
    background-color: var(--surface-console) !important;
    border: 1px solid var(--line-hair);
}

.agent-name {
    font-size: var(--text-sm);
    color: var(--text-faint);
}

// Предупреждение о текстовом режиме - та же полоса внимания, что в инспекторе
.alert-warning {
    border: 1px solid color-mix(in srgb, var(--state-attention) 45%, transparent);
    background-color: color-mix(in srgb, var(--state-attention) 8%, transparent);
    border-radius: var(--radius-panel);
    color: var(--text-strong);
    font-size: var(--text-base);
}

// Видимый фокус нужен и кнопкам страницы: глобальные правила .btn его гасят
.btn:focus-visible,
.form-control:focus-visible,
.form-select:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
}
</style>
