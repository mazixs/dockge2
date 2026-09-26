<template>
    <div class="app-shell" :class="classes">
        <!-- While the panel updates, losing the connection is expected and the update says so -->
        <div v-if="!$root.socketIO.connected && !$root.socketIO.firstConnect && !panelUpdateSuppressing" class="lost-connection" role="alert">
            {{ $root.socketIO.connectionErrorMsg }}
        </div>
        <PanelUpdateOverlay v-if="panelUpdateMode" :mode="panelUpdateMode" />
        <header class="app-header" :inert="panelUpdateMode === 'overlay'">
            <router-link to="/" class="brand" aria-label="Dockge2">
                <InterfaceIcon name="box" class="brand-icon" />
                <BrandMark />
            </router-link>
            <ServerSwitcher v-if="$root.appReady" />
            <div class="header-right">
                <span v-if="$root.appReady" class="connection-state" :class="{ offline: !$root.socketIO.connected }">
                    <i aria-hidden="true"></i>{{ $t($root.socketIO.connected ? "familiarConnected" : "agentOffline") }}
                </span>
                <div v-if="!$root.appReady" class="pre-login-controls">
                    <LanguagePicker compact />
                    <ThemePicker compact />
                </div>
                <div v-if="$root.appReady" class="dropdown">
                    <button class="profile-trigger" type="button" data-bs-toggle="dropdown" :aria-label="$root.info.updateAvailable ? $t('accountMenuWithUpdate') : $t('accountMenu')" aria-expanded="false">
                        <span class="profile-pic">{{ $root.usernameFirstChar }}</span>
                        <!-- Told by the label above as well: a coloured dot on its own
                             says nothing to a screen reader -->
                        <span v-if="$root.info.updateAvailable" class="update-dot" aria-hidden="true"></span>
                    </button>
                    <ul class="dropdown-menu dropdown-menu-end">
                        <li><span class="dropdown-item-text">{{ $root.username || $t("accountMenu") }}</span></li>
                        <li><hr class="dropdown-divider" /></li>
                        <!-- Меню собрано группами: сначала работа со стеками, потом
                             разделы настроек, внизу - то, что касается этого
                             человека на этом устройстве. Выбор темы стоял посреди
                             ссылок и читался как еще один переход -->
                        <li><router-link to="/" class="dropdown-item">{{ $t("stacksTab") }}</router-link></li>
                        <li v-if="$root.canManageStacks"><router-link to="/console" class="dropdown-item">{{ $t("console") }}</router-link></li>
                        <li v-if="$root.canManageStacks">
                            <button class="dropdown-item" type="button" :disabled="scanning" @click.stop.prevent="scanFolder">
                                <span v-if="scanning" class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                                {{ scanning ? $t("scanFolderRunning") : $t("scanFolder") }}
                            </button>
                        </li>
                        <li><hr class="dropdown-divider" /></li>
                        <!-- Only ever here, and only when there is news: an update of the
                             panel is not what the first screen is for -->
                        <li v-if="$root.info.updateAvailable">
                            <router-link to="/settings/about" class="dropdown-item update-item">{{ $t("newUpdate") }}: {{ $root.info.latestVersion }}</router-link>
                        </li>
                        <li><router-link to="/settings/appearance" class="dropdown-item">{{ $t("settings") }}</router-link></li>
                        <li v-if="$root.isAdmin"><router-link to="/settings/users" class="dropdown-item">{{ $t("familiarUsers") }}</router-link></li>
                        <li v-if="$root.isAdmin"><router-link to="/settings/agents" class="dropdown-item">{{ $t("dockgeAgent", 2) }}</router-link></li>
                        <li><router-link to="/settings/security" class="dropdown-item">{{ $t("security") }}</router-link></li>
                        <li><hr class="dropdown-divider" /></li>
                        <li class="dropdown-item-text"><ThemePicker compact /></li>
                        <li v-if="!$root.authDisabled"><button class="dropdown-item" @click="$root.logout">{{ $t("logout") }}</button></li>
                    </ul>
                </div>
            </div>
        </header>
        <main class="application-content" :inert="panelUpdateMode === 'overlay'">
            <div v-if="$root.sessionBootstrapping && !$root.appReady" class="connection-pending" role="status">{{ $t("socketConnecting") }}</div>
            <div v-if="$root.sessionBootstrapError && !$root.appReady" class="connection-pending" role="alert">
                <p>{{ $t($root.sessionBootstrapError) }}</p>
                <button class="btn btn-primary" @click="$root.reconnectSocket()">{{ $t("retry") }}</button>
            </div>
            <router-view v-if="$root.appReady" />
            <Login v-if="!$root.loggedIn && $root.allowLoginDialog" />
        </main>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import BrandMark from "../components/BrandMark.vue";
import InterfaceIcon from "../components/InterfaceIcon.vue";
import LanguagePicker from "../components/LanguagePicker.vue";
import ThemePicker from "../components/ThemePicker.vue";
import Login from "../components/Login.vue";
import ServerSwitcher from "../components/ServerSwitcher.vue";
import PanelUpdateOverlay from "../components/PanelUpdateOverlay.vue";
import { ALL_ENDPOINTS } from "../../../common/util-common";

/** Имена файлов, которые имеет смысл принимать перетаскиванием */
const DROPPABLE = /^(compose|docker-compose)\.(ya?ml)$|^\.env/i;

export default defineComponent({

    components: {
        BrandMark,
        InterfaceIcon,
        LanguagePicker,
        ThemePicker,
        ServerSwitcher,
        Login,
        PanelUpdateOverlay,
    },

    data() {
        return {
            /** Whether a rescan of the stacks directory is still running */
            scanning: false,
        };
    },

    computed: {

        // Theme or Mobile
        classes() : Record<string, boolean> {
            const classes : Record<string, boolean> = {};
            classes[this.$root.theme] = true;
            classes["mobile"] = this.$root.isMobile;
            return classes;
        },

        /**
         * How the update of the panel is shown, or nothing. The banner waits until the
         * session is known, so a reload does not flash it before the overlay
         * @returns Presentation
         */
        panelUpdateMode() : "overlay" | "banner" | "" {
            const view = this.$root.panelUpdateView ?? "none";
            if (view === "banner" && this.$root.sessionBootstrapping) {
                return "";
            }
            return view === "none" ? "" : view;
        },

        panelUpdateSuppressing() : boolean {
            return this.$root.panelUpdateSuppressing === true;
        },

        /** Находимся ли мы на стеках: список, инспектор и редактор - одна вкладка */
        onStacks() : boolean {
            const path = this.$route.path;
            return path === "/" || path === "/new" || path.startsWith("/stack") || path.startsWith("/compose") || path.startsWith("/terminal");
        },

    },

    mounted() {
        // Слой один на приложение, поэтому способ открыть его живет в корне
        this.$root.openCreateStack = this.openCreateSheet;

        // Вставка в любом месте списка открывает слой уже заполненным
        document.addEventListener("paste", this.onPaste);
        window.addEventListener("dragover", this.onDragOver);
        window.addEventListener("drop", this.onDrop);
    },

    beforeUnmount() {
        this.$root.openCreateStack = null;
        document.removeEventListener("paste", this.onPaste);
        window.removeEventListener("dragover", this.onDragOver);
        window.removeEventListener("drop", this.onDrop);
    },

    methods: {
        /**
         * Открыть слой создания стека
         * @param prefill Вставленный текст, если он уже есть
         */
        openCreateSheet(prefill : unknown = "") {
            if (this.$root.canManageStacks) {
                this.$root.createStackSeed = typeof prefill === "string" ? prefill : "";
                this.$router.push("/new");
            }
        },

        /**
         * Вставка вне поля ввода: пользователь принес compose или команду.
         * Пока фокус в поле, вставка принадлежит полю, а не слою.
         * @param event Событие вставки
         */
        onPaste(event : ClipboardEvent) {
            // A read-only editor cancels the paste itself; it is not a paste "anywhere in the list"
            if (!this.$root.canManageStacks || event.defaultPrevented || this.isEditableTarget(event.target)) {
                return;
            }

            const text = event.clipboardData?.getData("text") ?? "";

            if (!this.looksLikeStack(text)) {
                return;
            }

            event.preventDefault();
            this.openCreateSheet(text);
        },

        /**
         * Разрешить бросить файл в окно
         * @param event Событие перетаскивания
         */
        onDragOver(event : DragEvent) {
            if (this.$root.canManageStacks && event.dataTransfer?.types?.includes("Files")) {
                event.preventDefault();
            }
        },

        /**
         * Файл compose, брошенный в окно, открывает слой с его содержимым
         * @param event Событие сброса
         */
        async onDrop(event : DragEvent) {
            if (!this.$root.canManageStacks) {
                return;
            }

            const file = event.dataTransfer?.files?.[0];

            if (!file || !DROPPABLE.test(file.name)) {
                return;
            }

            event.preventDefault();
            this.openCreateSheet(await file.text());
        },

        /**
         * Находится ли фокус в поле, которому вставка нужнее
         * @param target Цель события
         * @returns Признак поля ввода
         */
        isEditableTarget(target : EventTarget | null) {
            const element = target instanceof HTMLElement ? target : null;

            if (!element) {
                return false;
            }

            return element.isContentEditable
                || [ "INPUT", "TEXTAREA", "SELECT" ].includes(element.tagName);
        },

        /**
         * Похоже ли вставленное на стек: только тогда стоит перехватывать вставку
         * @param text Вставленный текст
         * @returns Признак compose или команды docker run
         */
        looksLikeStack(text : string) {
            return /^\s*(sudo\s+)?docker\s+run\b/.test(text) || /^\s*services\s*:/m.test(text);
        },

        /**
         * Re-read the stacks directory.
         *
         * The scan walks the directory, asks Docker about every project and reads the
         * history of each one, so on a busy machine it takes a noticeable moment. It
         * used to give no sign of any of that: the menu closed, nothing moved, and a
         * toast saying "Updated" arrived later without saying what was updated. The
         * item now stays put and spins while it works, and the result names the number
         * of stacks the scan ended up with, which is the one thing the reader pressed
         * it to find out.
         */
        scanFolder() {
            if (this.scanning) {
                return;
            }

            this.scanning = true;

            this.$root.emitAgentRequest(ALL_ENDPOINTS, "requestStackList", []).then((res) => {
                this.scanning = false;

                if (!res?.ok) {
                    this.$root.toastRes(res);
                    return;
                }

                const found = Object.keys(this.$root.completeStackList ?? {}).length;
                this.$root.toastRes({ ok: true,
                    msgi18n: true,
                    msg: { key: "scanFolderDone",
                        values: { count: found } } });
            });
        },
    },

});
</script>

<style lang="scss" scoped>
.app-header { display: flex; align-items: center; gap: var(--gap-xl); height: var(--header-height); padding: 0 var(--gap-xl); border-bottom: 1px solid var(--line-hair); background: var(--surface-panel); }
.brand { display: inline-flex; gap: var(--gap-sm); align-items: center; color: var(--text-strong); text-decoration: none; font-size: var(--text-lg); font-weight: var(--weight-strong); letter-spacing: var(--tracking-title); width: calc(var(--sidebar-width) - var(--gap-xl) * 2); flex-shrink: 0; }
.brand-icon { font-size: var(--text-title-sm); color: var(--accent-text); }
.header-right { margin-left: auto; display: flex; gap: var(--gap-xl); align-items: center; }
.pre-login-controls { display: flex; gap: var(--gap-sm); align-items: center; }
.connection-state { font-size: var(--text-sm); color: var(--text-muted); display: flex; align-items: center; gap: var(--gap-sm); white-space: nowrap; }
.connection-state i { background: var(--state-running); width: 6px; height: 6px; border-radius: 50%; }
.connection-state.offline i { background: var(--state-failed); }
.profile-trigger { background: transparent; border: none; padding: var(--gap-xs); min-width: 44px; min-height: 44px; position: relative; }
.profile-pic { width: 32px; height: 32px; display: grid; place-items: center; background: var(--surface-raised); color: var(--text-strong); border-radius: 50%; font-size: var(--text-xs); }
/* A small dot beside the avatar. News about the version of the panel must not compete
   with a stack that is in trouble, so there is no counter and no state colour here.
   The ring is the colour of the header, so the dot reads as one shape on any theme */
.update-dot { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent-text); border: 2px solid var(--surface-panel); }
.update-item { font-weight: var(--weight-strong); }
.connection-pending { padding: var(--gap-xl); color: var(--text-muted); }
.lost-connection { background: var(--surface-panel); color: var(--state-failed); padding: var(--gap-md) var(--gap-xl); }
@media (max-width: 800px) {
    .app-header { padding: 0 var(--gap-md); gap: var(--gap-md); }
    .brand { width: auto; font-size: var(--text-md); gap: var(--gap-xs); }
    .brand-icon { font-size: var(--text-lg); }
    .header-right { gap: 0; }
    .connection-state { display: none; }
}
@media (max-width: 360px) { .brand > span { display: none; } }
</style>
