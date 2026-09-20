<template>
    <!-- Внутри страницы стека появление дает вкладка: второй въезд наложился бы на первый -->
    <transition name="slide-fade" :appear="!embedded" :css="!embedded">
        <!-- На своей странице редактор - обычная страница рабочей области; внутри
             страницы стека шаг между панелями задает сама вкладка -->
        <div :class="{ page: !embedded }">
            <!-- Внутри страницы стека заголовок уже есть: редактор не повторяет имя -->
            <h1 v-if="isAdd">{{ $t("compose") }}</h1>
            <h1 v-else-if="!embedded">
                <!-- Инспектор остается тем, откуда пришли: имя стека ведет назад -->
                <router-link :to="url" class="back">{{ stack.name }}</router-link>
                <span class="file-name">/ {{ stack.composeFileName }}</span>
                <span v-if="$root.agentCount > 1 && endpoint !== ''" class="agent-name">
                    ({{ endpointDisplay }})
                </span>
            </h1>
            <!-- Ход команды. Внутри страницы стека его показывает сама страница
                 панелью под кнопками: один вывод нельзя слушать двумя терминалами,
                 второй отнял бы у первого имя и строки -->
            <transition v-if="!embedded" name="slide-fade" appear>
                <Terminal
                    v-show="showProgressTerminal"
                    ref="progressTerminal"
                    class="terminal"
                    :name="terminalName"
                    :endpoint="endpoint"
                    :rows="progressTerminalRows"
                    @has-data="showProgressTerminal = true; submitted = true;"
                ></Terminal>
            </transition>

            <!-- Страница собрана из панелей одной анатомии: шапка с именем и действиями,
                 тело, подпись. Отдельных заголовков между панелями нет - имя панели и
                 есть заголовок раздела, поэтому в шапке стоит h2, как в настройках -->
            <div v-if="stack.isManagedByDockge" :class="embedded ? 'files-stack' : 'files-grid'">
                <div :class="embedded ? 'files-column' : 'editor-column'">
                    <!-- General -->
                    <section v-if="isAdd" class="panel">
                        <div class="panel-bar">
                            <h2 class="panel-title"><InterfaceIcon name="sliders" />{{ $t("general") }}</h2>
                        </div>
                        <div class="panel-body fields">
                            <!-- Stack Name -->
                            <div class="field">
                                <label for="name" class="form-label">{{ $t("stackName") }}</label>
                                <input id="name" v-model="stack.name" type="text" class="form-control" required @blur="stackNameToLowercase">
                                <div class="form-text">{{ $t("Lowercase only") }}</div>
                            </div>

                            <!-- Endpoint -->
                            <div class="field">
                                <label for="endpoint" class="form-label">{{ $t("dockgeAgent") }}</label>
                                <select id="endpoint" v-model="stack.endpoint" class="form-select">
                                    <option v-for="(agent, agentEndpoint) in $root.agentList" :key="agentEndpoint" :value="agentEndpoint" :disabled="$root.agentStatusList[agentEndpoint] != 'online'">
                                        ({{ $root.agentStatusList[agentEndpoint] }}) {{ (agent.name !== '') ? agent.name : agent.url || $t("Current") }}
                                    </option>
                                </select>
                            </div>
                        </div>
                    </section>

                    <!-- Файл стека: шапка называет файл и откуда он взят, действия стоят
                         рядом с ним, а подпись внизу обещает сохранность исходного текста -->
                    <section class="panel file-card">
                        <div class="panel-bar">
                            <h2 class="panel-title mono"><InterfaceIcon name="file" />{{ stack.composeFileName }}</h2>
                            <span v-if="!isAdd" class="panel-meta">{{ $t("gitUiOnServer") }}</span>

                            <button class="icon-btn" type="button" :title="$t('copyFile')" :aria-label="$t('copyFile')" @click="copyCompose">
                                <font-awesome-icon icon="copy" />
                            </button>

                            <!-- Здесь только правка файла: остановить, обновить и удалить можно из инспектора -->
                            <template v-if="isEditMode">
                                <button class="btn btn-sm btn-primary" :disabled="processing" @click="deployStack">
                                    <font-awesome-icon icon="rocket" />{{ $t("deployStack") }}
                                </button>

                                <button class="btn btn-sm btn-normal" :disabled="processing" @click="saveStack">
                                    <font-awesome-icon icon="save" />{{ $t("saveStackDraft") }}
                                </button>

                                <button v-if="!isAdd" class="btn btn-sm btn-normal" :disabled="processing" @click="discardStack">{{ $t("discardStack") }}</button>
                            </template>

                            <button v-else class="btn btn-sm btn-primary" :disabled="processing || !filesAreReadable" @click="enableEditMode">
                                <font-awesome-icon icon="pen" />{{ $t("editStack") }}
                            </button>
                        </div>

                        <!-- YAML editor -->
                        <div class="editor-box" :class="{'edit-mode' : isEditMode}">
                            <code-mirror
                                ref="composeEditor"
                                v-model="stack.composeYAML"
                                :extensions="extensions"
                                minimal
                                wrap
                                dark
                                tab
                                :disabled="!isEditMode"
                                @change="yamlCodeChange"
                            />
                        </div>

                        <p class="panel-foot kept"><ShieldCheck />{{ $t("fileSourceNote") }}</p>
                    </section>

                    <!-- Файл, который не удалось прочитать, не показывается пустым: править
                         его нельзя, пока сервер не сможет его прочитать -->
                    <div v-if="!filesAreReadable" class="alert alert-danger" role="alert">
                        <font-awesome-icon icon="triangle-exclamation" />
                        {{ $t("stackFilesUnreadable", { files: unreadableFiles }) }}
                    </div>

                    <!-- Ошибка разбора называет строку и причину прямо под файлом -->
                    <p v-if="isEditMode && yamlError" class="yaml-error" role="alert">
                        <font-awesome-icon icon="triangle-exclamation" />{{ yamlError }}
                    </p>

                    <!-- A file the structured editor cannot rebuild stays in text mode -->
                    <div v-if="isEditMode && composeAnalysis && !structuredEditsEnabled && unsupportedConstructs.length > 0" class="alert alert-warning" role="alert">
                        <font-awesome-icon icon="triangle-exclamation" />
                        {{ $t("textModeOnly", [ unsupportedConstructs.join(", ") ]) }}
                    </div>

                    <!-- Env-файл стоит рядом с compose и в чтении, и в правке: режим
                         решает, можно ли править, а не существует ли файл на экране.
                         Раньше он появлялся только по кнопке "Изменить", и прочитать
                         .env было нельзя, хотя compose читался свободно -->
                    <section v-if="envPanelVisible" class="panel file-card">
                        <div class="panel-bar">
                            <h2 class="panel-title mono"><InterfaceIcon name="file" />{{ activeEnvFileName }}</h2>
                            <span v-if="!isAdd" class="panel-meta">{{ $t("gitUiOnServer") }}</span>

                            <button class="icon-btn" type="button" :title="$t('copyFile')" :aria-label="$t('copyFile')" @click="copyEnv">
                                <font-awesome-icon icon="copy" />
                            </button>

                            <!-- Правка включается и отсюда: режим один на экран, но кнопка
                                 стоит у того файла, который человек читает. Без нее env
                                 выглядел файлом, который вообще нельзя изменить. Акцент
                                 остается у compose: главное действие экрана одно -->
                            <button v-if="!isEditMode" class="btn btn-sm btn-normal" :disabled="processing" @click="enableEditMode">
                                <font-awesome-icon icon="pen" />{{ $t("editStack") }}
                            </button>
                        </div>

                        <!-- Переменные окружения свернуты, пока их не попросят показать:
                             экран открывают при людях, и пароль в .env не должен
                             появляться на нем сам собой -->
                        <p v-if="!envShown" class="panel-body env-hidden">
                            <span>{{ $t("envHidden") }}</span>
                            <button class="btn btn-sm btn-normal" type="button" @click="envRevealed = true">
                                <font-awesome-icon icon="eye" />{{ $t("envReveal") }}
                            </button>
                        </p>

                        <!-- Пустой файл говорит об этом словами: черный прямоугольник с одной
                             строкой читался как сбой загрузки, а не как файл без переменных -->
                        <p v-if="envShown && !isEditMode && envIsEmpty" class="panel-body empty-file">{{ $t("envFileEmpty") }}</p>

                        <div v-show="envShown && (isEditMode || !envIsEmpty)" class="editor-box" :class="{'edit-mode' : isEditMode}">
                            <code-mirror
                                ref="envEditor"
                                v-model="stack.composeENV"
                                :extensions="extensionsEnv"
                                minimal
                                wrap
                                dark
                                tab
                                :disabled="!isEditMode"
                                @change="yamlCodeChange"
                            />
                        </div>

                        <p v-if="envShown && (isEditMode || !envIsEmpty)" class="panel-foot kept"><ShieldCheck />{{ $t("fileSourceNote") }}</p>
                    </section>

                    <!-- Контейнеры: один список в одной панели. Каждый сервис - строка,
                         строка добавления стоит последней, где и появится новый сервис -->
                    <section v-if="isEditMode" class="panel service-list">
                        <div class="panel-bar">
                            <h2 class="panel-title"><InterfaceIcon name="box" />{{ $t("container", 2) }}</h2>
                            <span class="panel-meta">{{ Object.keys(jsonConfig.services ?? {}).length }}</span>
                        </div>

                        <div ref="containerList" class="service-rows">
                            <Container
                                v-for="(service, name) in jsonConfig.services"
                                :key="name"
                                :name="name"
                                :is-edit-mode="isEditMode && structuredEditsEnabled"
                                :first="name === Object.keys(jsonConfig.services ?? {})[0]"
                                :serviceStatus="serviceStatusList[name] ?? null"
                                :dockerStats="dockerStats"
                                :processing="processing"
                                @start-service="startService"
                                @stop-service="stopService"
                                @restart-service="restartService"
                            />
                        </div>

                        <div v-if="structuredEditsEnabled" class="panel-body add-service">
                            <input
                                v-model="newContainerName"
                                :placeholder="$t(`New Container Name...`)"
                                :aria-label="$t('addContainer')"
                                class="form-control"
                                @keyup.enter="addContainer"
                            />
                            <button class="btn btn-sm btn-normal" :disabled="!newContainerName" @click="addContainer">
                                <font-awesome-icon icon="plus" />{{ $t("addContainer") }}
                            </button>
                        </div>
                    </section>

                    <!-- Extra -->
                    <section v-if="isEditMode && structuredEditsEnabled" class="panel">
                        <div class="panel-bar">
                            <h2 class="panel-title"><InterfaceIcon name="sliders" />{{ $t("extra") }}</h2>
                        </div>
                        <div class="panel-body fields">
                            <!-- URLs -->
                            <div class="field">
                                <label class="form-label">{{ $t("url", 2) }}</label>
                                <ArrayInput name="urls" :display-name="$t('url')" placeholder="https://" object-type="x-dockge" />
                            </div>
                        </div>
                    </section>

                    <!-- Networks -->
                    <section v-if="isEditMode && structuredEditsEnabled" class="panel">
                        <div class="panel-bar">
                            <h2 class="panel-title"><InterfaceIcon name="network" />{{ $t("network", 2) }}</h2>
                        </div>
                        <div class="panel-body">
                            <NetworkInput />
                        </div>
                    </section>
                </div>
                <div :class="embedded ? 'files-column' : 'editor-column'">
                    <!-- Files of the stack directory -->
                    <StackFilesEditor
                        v-if="!isAdd && stack.isManagedByDockge && fileInventory"
                        :inventory="fileInventory"
                        :disabled="processing"
                        @save="saveFileSelection"
                        @create-env="createEnvFile"
                    />

                    <!-- Compose secrets stored as files -->
                    <SecretEditor
                        v-if="!isAdd && stack.isManagedByDockge && fileInventory"
                        :stackName="stack.name"
                        :endpoint="endpoint"
                        :secretFiles="fileInventory.secretFiles"
                        :services="serviceNames"
                        :disabled="processing"
                        @updated="onSecretsUpdated"
                    />
                </div>
            </div>

            <div v-if="!stack.isManagedByDockge && !processing">
                {{ $t("stackNotManagedByDockgeMsg") }}
            </div>

            <!-- Файл изменился вне редактора: выбирают между версией на сервере и своей -->
            <Confirm
                ref="conflictConfirm"
                btn-style="btn-primary"
                :title="$t('stackSaveConflictTitle')"
                :yes-text="$t('stackSaveReload')"
                :no-text="$t('stackSaveOverwrite')"
                @yes="reloadAfterConflict"
                @no="overwriteAfterConflict"
            >
                {{ $t("stackSaveConflictText", { file: conflictFile }) }}
            </Confirm>
        </div>
    </transition>
</template>

<script>
// @ts-check
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
import InterfaceIcon from "../components/InterfaceIcon.vue";
import ShieldCheck from "../components/ShieldCheck.vue";
import Confirm from "../components/Confirm.vue";
import dotenv from "dotenv";
import { markRaw, ref } from "vue";
import { RequestTracker } from "../request-tracker";
import { errorText } from "../util-frontend";

/**
 * The stack this editor is on.
 *
 * The texts and the names are always there, empty until something fills them: an editor
 * exists before the server answers, and a field that appears only with the answer turns
 * every use of it into a guess.
 * @typedef {Partial<import("../../../common/types/stack").StackDTO> & {
 *     name : string,
 *     composeYAML : string,
 *     composeENV : string,
 *     endpoint : string,
 * }} EditorStack
 */

/**
 * A stack nobody has loaded yet
 * @returns {EditorStack} Empty stack
 */
function emptyStack() {
    return { name: "",
        composeYAML: "",
        composeENV: "",
        endpoint: "" };
}

const template = `
services:
  nginx:
    image: nginx:latest
    restart: unless-stopped
    ports:
      - "8080:80"
`;
const envDefault = "# VARIABLE=value #comment";

/** @type {ReturnType<typeof setTimeout> | undefined} */
let yamlErrorTimeout;

/** @type {ReturnType<typeof setTimeout> | undefined} */
let serviceStatusTimeout;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let dockerStatsTimeout;

// Развертывание идет столько, сколько идет docker compose: подтверждение ждут долго,
// но не бесконечно - иначе потерянный ответ оставил бы кнопки заблокированными
const SAVE_REQUEST_TIMEOUT_MS = 15 * 60_000;

export default {
    components: {
        NetworkInput,
        FontAwesomeIcon,
        CodeMirror,
        StackFilesEditor,
        SecretEditor,
        InterfaceIcon,
        ShieldCheck,
        Confirm,
    },
    beforeRouteUpdate(to, from, next) {
        this.exitConfirm(next);
    },
    beforeRouteLeave(to, from, next) {
        this.exitConfirm(next);
    },
    props: {
        /** Редактор показан вкладкой страницы стека, а не отдельным экраном */
        embedded: {
            type: Boolean,
            default: false,
        },

        /** Стек, чьи файлы правим: во вкладке он приходит от страницы, а не из адреса */
        stackName: {
            type: String,
            default: "",
        },

        /** Агент стека, когда редактор встроен */
        endpointName: {
            type: String,
            default: "",
        },

        /**
         * Состояние сервисов, когда его уже читает страница стека.
         * Вкладка файлов не заводит собственный опрос того же самого: два опроса
         * одного стека удваивали и запросы к серверу, и вызовы docker stats
         */
        statusList: {
            type: Object,
            default: null,
        },

        /** Расход контейнеров, оттуда же */
        statsList: {
            type: Object,
            default: null,
        },
    },
    // Страница стека слушает ход команды: ее панель показывает вывод редактора
    emits: [ "run-start", "run-end" ],
    setup() {
        const editorFocus = ref(false);

        /**
         * Remember whether the text editor has the keyboard
         * @param {import("@codemirror/state").EditorState} state Editor state the change belongs to
         * @param {boolean} focusing Whether the editor took the focus
         * @returns {null} No effect is added to the transaction
         */
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
    data() {
        return {
            /** @type {import("../../../common/compose-editor").ComposeModel} */
            jsonConfig: {},
            /** @type {import("../../../common/compose-editor").ComposeModel} */
            envsubstJSONConfig: {},
            yamlError: "",
            processing: true,
            showProgressTerminal: false,
            progressTerminalRows: PROGRESS_TERMINAL_ROWS,
            /** @type {EditorStack} */
            stack: emptyStack(),
            /** @type {import("../../../common/agent-events").ServiceStatusList} */
            serviceStatusList: {},
            /** @type {import("../../../common/types/stack").StackFileInventory | null} */
            fileInventory: null,
            /** @type {import("../../../common/compose-editor").ComposeAnalysis | null} */
            composeAnalysis: null,
            /** Text the current model and analysis were built from */
            analysedSource: "",
            /** Whether the compose file had a top level networks key when it was loaded */
            sourceHadNetworks: false,
            /** True while the model is filled from the server or the text editor */
            applyingExternal: false,
            /** Set when the user removed the last network by hand */
            explicitNetworkRemoval: false,
            /** @type {import("../../../common/util-common").LooseObject} */
            dockerStats: {},
            isEditMode: false,
            // Значения .env показываются только по просьбе: см. панель env в шаблоне
            envRevealed: false,
            submitted: false,
            newContainerName: "",
            stopServiceStatusTimeout: false,
            stopDockerStatsTimeout: false,
            /**
             * Чьи ответы относятся к открытому стеку: редактор переживает смену стека
             * во вкладке, и один запрос каждого вида идет за раз
             */
            requests: markRaw(new RequestTracker()),
            /**
             * Hashes of the files this editor loaded, sent back so a stale save is refused
             * @type {import("../../../common/types/stack").StackFileBaseline | null}
             */
            fileBaseline: null,
            /**
             * Files the server could not read, so this editor must not save over them
             * @type {import("../../../common/types/stack").StackFileReadIssue[]}
             */
            readIssues: [],
            /** File a refused save named, shown while the conflict dialog is open */
            conflictFile: "",
            /**
             * What the conflict dialog repeats once the user chooses to overwrite
             * @type {"saveStack" | "deployStack" | null}
             */
            pendingSave: null,
        };
    },
    computed: {
        endpointDisplay() {
            return this.$root.endpointDisplayFunction(this.endpoint);
        },

        /**
         * Links of the stack, as the x-dockge extension of the compose file lists them
         * @returns {{ display : string, url : string }[]} Links to show
         */
        urls() {
            const configured = this.envsubstJSONConfig["x-dockge"]?.urls;

            if (!Array.isArray(configured)) {
                return [];
            }

            /** @type {{ display : string, url : string }[]} */
            const urls = [];
            for (const url of configured) {
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
            return !this.embedded && this.$route.path === "/compose" && !this.submitted;
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
         * Whether the shown env file has no content yet
         * @returns {boolean} True when the file is empty or only whitespace
         */
        envIsEmpty() {
            return (this.stack.composeENV ?? "").trim() === "";
        },

        /**
         * Whether the env panel belongs on the page.
         * While editing it is always there: an empty `.env` is a draft the save can
         * create. While viewing, a file that is not on disk would be an empty promise.
         * @returns {boolean} True when the panel is shown
         */
        /**
         * Whether the env values are on screen.
         * A new stack has nothing to hide yet, so its field is open from the start.
         * @returns {boolean} True when the file contents are shown
         */
        envShown() {
            return this.envRevealed || this.isAdd;
        },

        envPanelVisible() {
            if (this.isAdd || this.isEditMode) {
                return true;
            }

            return (this.fileInventory?.envFileNames ?? []).includes(this.activeEnvFileName);
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

        /**
         * Agent the stack lives on, empty for this panel
         * @returns {string} Name of the agent
         */
        endpoint() {
            return this.stack.endpoint || this.endpointName || String(this.$route.params.endpoint ?? "");
        },

        /**
         * Whether every file of this stack could be read
         * @returns {boolean} True when nothing failed to read
         */
        filesAreReadable() {
            return (this.readIssues ?? []).length === 0;
        },

        /**
         * Files the server could not read, as one readable list
         * @returns {string} File names separated by commas
         */
        unreadableFiles() {
            return (this.readIssues ?? []).map((issue) => `${issue.fileName} (${issue.code})`).join(", ");
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
        // Другой стек - другие переменные: раскрытие не переезжает между стеками
        "$route.params.stackName"() {
            this.envRevealed = false;
        },

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

        },

        statusList: {
            immediate: true,
            handler(value) {
                if (this.embedded && value) {
                    this.serviceStatusList = value;
                }
            },
        },

        statsList: {
            immediate: true,
            handler(value) {
                if (this.embedded && value) {
                    this.dockerStats = value;
                }
            },
        },
    },
    mounted() {
        if (!this.$root.canManageStacks) {
            this.$router.replace("/");
            return;
        }
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
            this.stack.name = this.embedded ? this.stackName : String(this.$route.params.stackName ?? "");
            this.loadStack();
        }

        // Встроенный редактор получает состояние от страницы стека, которая и так
        // его опрашивает: собственный опрос был бы вторым таким же
        if (!this.embedded) {
            this.requestServiceStatus();
            this.requestDockerStats();
        }
    },
    unmounted() {
        // Уход со страницы не всегда проходит через exitAction: таймер, оставшийся
        // от размонтированного редактора, опрашивал бы сервер до перезагрузки вкладки
        this.requests.invalidate();
        this.stopServiceStatusTimeout = true;
        this.stopDockerStatsTimeout = true;
        clearTimeout(serviceStatusTimeout);
        clearTimeout(dockerStatsTimeout);
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

            this.$root.emitAgentRequest(this.endpoint, "getStackFiles", [ this.stack.name ]).then((res) => {
                if (res.ok) {
                    this.fileInventory = res.inventory;
                }
            });
        },

        /**
         * Store a new file selection and reload the stack, because the shown texts may change
         * @param {import("../../../common/types/stack").StackFileConfig} config Selection from the editor
         * @returns {void}
         */
        saveFileSelection(config) {
            this.processing = true;

            this.$root.emitAgentRequest(this.endpoint, "setStackFiles", [ this.stack.name, config ]).then((res) => {
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
         * Create an empty env file in the stack directory.
         * Only the file appears. Which files compose interpolates and which one the
         * editor shows stay a separate, explicit choice: folding them into one action
         * would swap the text under an open editor and write it back into the new file.
         * @param {string} fileName Name typed in the file selection panel
         * @returns {void}
         */
        createEnvFile(fileName) {
            this.processing = true;

            this.$root.emitAgentRequest(this.endpoint, "saveEnvFile", [ this.stack.name, fileName, "" ]).then((res) => {
                this.processing = false;
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestStackFiles();
                }
            });
        },

        /**
         * Refresh the secret list after an authorised secret action
         * @param {import("../../../common/types/stack").SecretFileMeta[]} secretFiles New metadata
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
            if (this.isAdd || this.embedded) {
                return;
            }

            const generation = this.requests.generation;

            this.requests.run("status", generation, () => this.$root.emitAgentRequest(this.endpoint, "serviceStatusList", [ this.stack.name ])).then((res) => {
                // null: запрос не отправлялся или ответ относится к прежнему стеку
                if (!res) {
                    return;
                }

                if (res.ok) {
                    this.serviceStatusList = res.serviceStatusList;
                }
                if (!this.stopServiceStatusTimeout) {
                    this.startServiceStatusTimeout();
                }
            });
        },

        requestDockerStats() {
            if (this.embedded) {
                return;
            }

            const generation = this.requests.generation;

            this.requests.run("stats", generation, () => this.$root.emitAgentRequest(this.endpoint, "dockerStats", [])).then((res) => {
                if (!res) {
                    return;
                }

                if (res.ok) {
                    this.dockerStats = res.dockerStats;
                }
                if (!this.stopDockerStatsTimeout) {
                    this.startDockerStatsTimeout();
                }
            });
        },

        /**
         * Ask before leaving with unsaved edits
         * @param {import("vue-router").NavigationGuardNext} next How the router is answered
         * @returns {void}
         */
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

            // Вывод стека живет во вкладке журнала: она сама решает, когда
            // отписаться, поэтому уход с файлов не обрывает чужие логи
        },

        /**
         * Скопировать текст env-файла как он есть на экране
         * @returns {Promise<void>}
         */
        async copyEnv() {
            try {
                await navigator.clipboard.writeText(this.stack.composeENV);
                this.$root.toastSuccess(this.$t("copiedToClipboard"));
            } catch (e) {
                this.$root.toastError(errorText(e));
            }
        },

        /**
         * Скопировать текст compose как он есть на экране: без пересборки YAML,
         * иначе в буфер ушел бы не тот текст, что лежит на сервере
         * @returns {Promise<void>}
         */
        async copyCompose() {
            try {
                await navigator.clipboard.writeText(this.stack.composeYAML);
                this.$root.toastSuccess(this.$t("copiedToClipboard"));
            } catch (e) {
                this.$root.toastError(errorText(e));
            }
        },

        /**
         * Point the progress terminal at the output of this stack
         * @returns {void}
         */
        bindTerminal() {
            const terminal = /** @type {InstanceType<typeof import("../components/Terminal.vue").default> | undefined} */ (this.$refs.progressTerminal);
            terminal?.bind(this.endpoint, this.terminalName);
        },

        loadStack() {
            this.processing = true;
            this.$root.emitAgentRequest(this.endpoint, "getStack", [ this.stack.name ]).then((res) => {
                if (res.ok) {
                    this.stack = res.stack;
                    // What was read is the version every later save is compared against
                    this.fileBaseline = res.stack.fileHashes ?? null;
                    this.readIssues = res.stack.readIssues ?? [];
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

            const [ serviceName ] = Object.keys(this.jsonConfig.services);

            // Set the stack name if empty, use the first container name
            if (!this.stack.name && serviceName !== undefined) {
                const service = this.jsonConfig.services[serviceName];

                this.stack.name = service?.container_name || serviceName;
            }

            this.sendStack("deployStack", this.saveBaseline());
        },

        /**
         * Write the files without starting anything
         * @returns {void}
         */
        saveStack() {
            this.sendStack("saveStack", this.saveBaseline());
        },

        /**
         * What this editor read, as the server expects it.
         * A new stack states that neither file exists yet, so a directory that appeared
         * in the meantime is a conflict rather than something to write into.
         * @returns {import("../../../common/types/stack").StackFileBaseline | undefined} Hashes of the loaded files
         */
        saveBaseline() {
            if (this.isAdd) {
                return { compose: null,
                    env: null };
            }

            return this.fileBaseline ?? undefined;
        },

        /**
         * Send the files to the server and deal with what comes back.
         * @param {"saveStack" | "deployStack"} event What the files are sent for
         * @param {import("../../../common/types/stack").StackFileBaseline | undefined} baseline Version the editor started from, undefined to overwrite
         * @returns {void}
         */
        sendStack(event, baseline) {
            this.processing = true;

            if (event === "deployStack") {
                this.bindTerminal();
                // Вывод развертывания идет в терминал прогресса. Во вкладке файлов его
                // показывает страница стека, поэтому она должна узнать о начале
                this.$emit("run-start", "deployStack");
            }

            this.$root.emitAgentRequest(this.stack.endpoint, event, [
                this.stack.name,
                this.stack.composeYAML,
                this.stack.composeENV,
                this.isAdd,
                baseline,
            ], { timeoutMs: SAVE_REQUEST_TIMEOUT_MS }).then((res) => {
                this.processing = false;

                if (event === "deployStack") {
                    // Потерянный ответ не значит отказ: файлы могли быть записаны и
                    // развертывание могло пройти, поэтому итог называется неизвестным
                    this.$emit("run-end", res.ok ? "ok" : (res.unknown ? "unknown" : "failed"));
                }

                // Ответ не пришел: правки остаются на экране, а состояние файлов на
                // сервере перечитывается, потому что оно могло измениться
                if (!res.ok && res.unknown) {
                    this.$root.toastRes(res);
                    this.requestStackFiles();
                    return;
                }

                if (!res?.ok && typeof res?.msg === "object" && res.msg.key === "stackSelectionChangedElsewhere") {
                    // Другой файл, а не другая версия: перезаписывать нечего, потому что
                    // редактор смотрел на файл, с которым стек больше не работает. Текст
                    // остается на экране - это правки пользователя, а не сервера
                    this.$root.toastRes(res);
                    this.requestStackFiles();
                    return;
                }

                if (!res?.ok && typeof res?.msg === "object" && res.msg.key === "stackFileChangedElsewhere") {
                    // Someone else wrote the file. The choice belongs to the user, so
                    // neither version is applied until they pick one.
                    this.conflictFile = String(res.msg.values?.file ?? "");
                    this.pendingSave = event;
                    const dialog = /** @type {InstanceType<typeof Confirm>} */ (this.$refs.conflictConfirm);
                    dialog.show();
                    return;
                }

                this.$root.toastRes(res);

                if (res.ok) {
                    if (res.fileHashes) {
                        this.fileBaseline = res.fileHashes;
                    }
                    this.isEditMode = false;
                    this.$router.push(this.url);
                }
            });
        },

        /**
         * Take the version on the server and lose the edits of this editor
         * @returns {void}
         */
        reloadAfterConflict() {
            this.pendingSave = null;
            this.conflictFile = "";
            this.loadStack();
        },

        /**
         * Write this editor's text over the version on the server, as the user asked
         * @returns {void}
         */
        overwriteAfterConflict() {
            const event = this.pendingSave ?? "saveStack";
            this.pendingSave = null;
            this.conflictFile = "";
            this.sendStack(event, undefined);
        },

        discardStack() {
            this.loadStack();
            this.isEditMode = false;
        },

        /**
         * Read a compose text as an object, keeping the document it came from
         * @param {string} yaml Text of the file
         * @returns {{ config : import("../../../common/compose-editor").ComposeModel, doc : import("yaml").Document.Parsed }} The object and the parsed document
         * @throws {Error} If the text is not a compose file this editor can read
         */
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
                const { config } = this.yamlToJSON(this.stack.composeYAML);

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
                    this.yamlError = errorText(e);

                } else {
                    yamlErrorTimeout = setTimeout(() => {
                        this.yamlError = errorText(e);
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
                this.yamlError = errorText(e);
                return;
            }

            if (next === source) {
                return;
            }

            this.applyingExternal = true;
            this.stack.composeYAML = next;
            this.composeAnalysis = analyseComposeSource(next);
            this.analysedSource = next;
            this.$nextTick(() => {
                this.applyingExternal = false;
            });
        },

        /**
         * Apply a network edit coming from the network editor.
         * An empty result never introduces `networks: {}` on its own.
         * @param {Record<string, import("../../../common/util-common").LooseObject>} networks Networks the user configured
         * @param {{ explicitRemoval? : boolean }} options Extra flags, `explicitRemoval` when the user deleted the last network
         * @returns {void}
         */
        applyNetworksEdit(networks, options = {}) {
            /** @type {Record<string, import("../../../common/util-common").LooseObject>} */
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

            const services = this.jsonConfig.services ?? {};

            if (services[this.newContainerName]) {
                this.$root.toastError("Container name already exists");
                return;
            }

            if (!this.newContainerName) {
                this.$root.toastError("Container name cannot be empty");
                return;
            }

            services[this.newContainerName] = {
                restart: "unless-stopped",
            };
            this.jsonConfig.services = services;
            this.newContainerName = "";
            const list = /** @type {HTMLElement | undefined} */ (this.$refs.containerList);
            list?.lastElementChild?.scrollIntoView({
                block: "start",
                behavior: "smooth"
            });
        },

        /**
         * Stack directories are lower case, so the name is too
         * @returns {void}
         */
        stackNameToLowercase() {
            this.stack.name = this.stack.name.toLowerCase();
        },

        /**
         * Start one service of the stack
         * @param {string} serviceName Service the button belongs to
         * @returns {void}
         */
        startService(serviceName) {
            this.processing = true;
            this.$emit("run-start", "startService");

            this.$root.emitAgentRequest(this.endpoint, "startService", [ this.stack.name, serviceName ], { timeoutMs: SAVE_REQUEST_TIMEOUT_MS }).then((res) => {
                this.processing = false;
                this.$emit("run-end", res?.ok ? "ok" : (res?.unknown ? "unknown" : "failed"));
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestServiceStatus(); // Refresh service status
                }
            });
        },

        /**
         * Stop one service of the stack
         * @param {string} serviceName Service the button belongs to
         * @returns {void}
         */
        stopService(serviceName) {
            this.processing = true;
            this.$emit("run-start", "stopService");

            this.$root.emitAgentRequest(this.endpoint, "stopService", [ this.stack.name, serviceName ], { timeoutMs: SAVE_REQUEST_TIMEOUT_MS }).then((res) => {
                this.processing = false;
                this.$emit("run-end", res?.ok ? "ok" : (res?.unknown ? "unknown" : "failed"));
                this.$root.toastRes(res);

                if (res.ok) {
                    this.requestServiceStatus(); // Refresh service status
                }
            });
        },

        /**
         * Restart one service of the stack
         * @param {string} serviceName Service the button belongs to
         * @returns {void}
         */
        restartService(serviceName) {
            this.processing = true;
            this.$emit("run-start", "restartService");

            this.$root.emitAgentRequest(this.endpoint, "restartService", [ this.stack.name, serviceName ], { timeoutMs: SAVE_REQUEST_TIMEOUT_MS }).then((res) => {
                this.processing = false;
                this.$emit("run-end", res?.ok ? "ok" : (res?.unknown ? "unknown" : "failed"));
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
    font-weight: var(--weight-strong);
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

// Внутри страницы стека панели стоят одной колонкой с общим шагом; на своей
// странице редактор держит две колонки bootstrap
.files-stack {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}

.files-column {
    display: contents;
}

// На своей странице редактор держит две колонки: слева правка, справа файлы
.files-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--gap-lg);
}

.editor-column {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
    min-width: 0;
}

.fields {
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
}

@media (max-width: 992px) {
    .files-grid {
        grid-template-columns: minmax(0, 1fr);
    }
}

// Строка добавления сервиса стоит под списком, отделена линией как еще одна строка
.add-service {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    border-top: 1px solid var(--line-hair);

    .form-control {
        flex: 1 1 200px;
        max-width: 360px;
    }
}

.service-list .service-rows:empty + .add-service {
    border-top: 0;
}

// Ошибка разбора: красным словом под файлом, без рамки - это не панель
.yaml-error {
    display: flex;
    align-items: baseline;
    gap: var(--gap-sm);
    margin: 0;
    color: var(--state-failed);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    overflow-wrap: anywhere;
}

.alert {
    margin: 0;
}

// Пустой файл - строка на поверхности панели, а не консольная подложка: место,
// где нечего читать, не должно выглядеть как погасший экран
.empty-file {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.env-hidden {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.form-text {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-faint);
}

.terminal {
    height: 200px;
}

.icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control-height);
    height: var(--control-height);
    border: 0;
    border-radius: var(--radius-control);
    background: none;
    color: var(--text-muted);
    transition: color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);

    &:hover {
        background-color: var(--surface-raised);
        color: var(--text-strong);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.agent-name {
    font-size: var(--text-sm);
    color: var(--text-faint);
}

// Видимый фокус нужен и кнопкам страницы: глобальные правила .btn его гасят
.btn:focus-visible,
.form-control:focus-visible,
.form-select:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
}
</style>
