<template>
    <div :class="classes">
        <div v-if="! $root.socketIO.connected && ! $root.socketIO.firstConnect" class="lost-connection">
            <div class="container-fluid">
                {{ $root.socketIO.connectionErrorMsg }}
                <div v-if="$root.socketIO.showReverseProxyGuide">
                    {{ $t("reverseProxyMsg1") }} <a href="https://github.com/louislam/uptime-kuma/wiki/Reverse-Proxy" target="_blank">{{ $t("reverseProxyMsg2") }}</a>
                </div>
            </div>
        </div>

        <!-- Desktop header -->
        <header v-if="! $root.isMobile" class="app-header d-flex flex-wrap justify-content-center py-3 mb-3">
            <router-link to="/" class="brand d-flex align-items-center mb-3 mb-md-0 me-md-auto text-decoration-none">
                <object class="bi me-2 ms-4" width="40" height="40" data="/icon.svg" />
                <span class="title">Dockge</span>
            </router-link>

            <button v-if="$root.loggedIn" class="btn btn-primary me-3 create-stack-btn" type="button" @click="openCreateSheet()">
                <font-awesome-icon icon="plus" /> {{ $t("deployStackAction") }}
            </button>

            <a v-if="hasNewVersion" target="_blank" href="https://github.com/louislam/dockge/releases" class="btn btn-warning me-3">
                <font-awesome-icon icon="arrow-alt-circle-up" /> {{ $t("newUpdate") }}
            </a>

            <ul class="nav app-nav">
                <li v-if="$root.loggedIn" class="nav-item">
                    <router-link to="/" class="tab">
                        <font-awesome-icon icon="home" /> {{ $t("home") }}
                    </router-link>
                </li>

                <li v-if="$root.loggedIn" class="nav-item">
                    <router-link to="/console" class="tab">
                        <font-awesome-icon icon="terminal" /> {{ $t("console") }}
                    </router-link>
                </li>

                <li v-if="$root.loggedIn" class="nav-item">
                    <div class="dropdown dropdown-profile-pic">
                        <button class="profile-trigger" type="button" data-bs-toggle="dropdown" :aria-label="$t('accountMenu')">
                            <div class="profile-pic">{{ $root.usernameFirstChar }}</div>
                            <font-awesome-icon icon="angle-down" />
                        </button>

                        <!-- Header's Dropdown Menu -->
                        <ul class="dropdown-menu">
                            <!-- Username -->
                            <li>
                                <i18n-t v-if="$root.username != null" scope="global" tag="span" keypath="signedInDisp" class="dropdown-item-text">
                                    <strong>{{ $root.username }}</strong>
                                </i18n-t>
                                <span v-else-if="$root.authDisabled" class="dropdown-item-text">{{ $t("signedInDispDisabled") }}</span>
                            </li>

                            <li><hr class="dropdown-divider"></li>

                            <!-- Functions -->

                            <!--<li>
                                <router-link to="/registry" class="dropdown-item" :class="{ active: $route.path.includes('settings') }">
                                    <font-awesome-icon icon="warehouse" /> {{ $t("registry") }}
                                </router-link>
                            </li>-->

                            <li>
                                <button class="dropdown-item" @click="scanFolder">
                                    <font-awesome-icon icon="arrows-rotate" /> {{ $t("scanFolder") }}
                                </button>
                            </li>

                            <li>
                                <router-link to="/settings/general" class="dropdown-item" :class="{ active: $route.path.includes('settings') }">
                                    <font-awesome-icon icon="cog" /> {{ $t("Settings") }}
                                </router-link>
                            </li>

                            <!-- Nothing to sign out of when authentication is disabled -->
                            <li v-if="! $root.authDisabled">
                                <button class="dropdown-item" @click="$root.logout">
                                    <font-awesome-icon icon="sign-out-alt" />
                                    {{ $t("Logout") }}
                                </button>
                            </li>
                        </ul>
                    </div>
                </li>
            </ul>
        </header>

        <main>
            <div v-if="$root.socketIO.connecting" class="container mt-5">
                <h4>{{ $t("connecting...") }}</h4>
            </div>

            <router-view v-if="$root.loggedIn" />
            <Login v-if="! $root.loggedIn && $root.allowLoginDialog" />
            <CreateStackSheet v-if="$root.loggedIn" ref="createSheet" />
            <TerminalDock v-if="$root.loggedIn" ref="dock" />
        </main>
    </div>
</template>

<script>
import Login from "../components/Login.vue";
import CreateStackSheet from "../components/CreateStackSheet.vue";
import TerminalDock from "../components/TerminalDock.vue";
import { compareVersions } from "compare-versions";
import { ALL_ENDPOINTS } from "../../../common/util-common";

/** Имена файлов, которые имеет смысл принимать перетаскиванием */
const DROPPABLE = /^(compose|docker-compose)\.(ya?ml)$|^\.env/i;

export default {

    components: {
        CreateStackSheet,
        Login,
        TerminalDock,
    },

    data() {
        return {

        };
    },

    computed: {

        // Theme or Mobile
        classes() {
            const classes = {};
            classes[this.$root.theme] = true;
            classes["mobile"] = this.$root.isMobile;
            return classes;
        },

        hasNewVersion() {
            if (this.$root.info.latestVersion && this.$root.info.version) {
                return compareVersions(this.$root.info.latestVersion, this.$root.info.version) >= 1;
            } else {
                return false;
            }
        },

    },

    watch: {

    },

    mounted() {
        // Слой один на приложение, поэтому способ открыть его живёт в корне
        this.$root.openCreateStack = this.openCreateSheet;

        // Док тоже один: вывод переживает переходы между стеками и экранами
        this.$root.openStackLogs = (stackName, endpoint) => this.$refs.dock?.openLogs(stackName, endpoint);
        this.$root.openContainerShell = (target) => this.$refs.dock?.openShell(target);
        this.$root.dockHasLogs = (stackName, endpoint) => this.$refs.dock?.hasLogs(stackName, endpoint) ?? false;

        // Вставка в любом месте списка открывает слой уже заполненным
        document.addEventListener("paste", this.onPaste);
        window.addEventListener("dragover", this.onDragOver);
        window.addEventListener("drop", this.onDrop);
    },

    beforeUnmount() {
        this.$root.openCreateStack = null;
        this.$root.openStackLogs = null;
        this.$root.openContainerShell = null;
        this.$root.dockHasLogs = null;
        document.removeEventListener("paste", this.onPaste);
        window.removeEventListener("dragover", this.onDragOver);
        window.removeEventListener("drop", this.onDrop);
    },

    methods: {
        /**
         * Открыть слой создания стека
         * @param {string} prefill Вставленный текст, если он уже есть
         * @returns {void}
         */
        openCreateSheet(prefill = "") {
            this.$refs.createSheet?.open(prefill);
        },

        /**
         * Вставка вне поля ввода: пользователь принёс compose или команду.
         * Пока фокус в поле, вставка принадлежит полю, а не слою.
         * @param {ClipboardEvent} event Событие вставки
         * @returns {void}
         */
        onPaste(event) {
            if (!this.$root.loggedIn || this.isEditableTarget(event.target)) {
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
         * @param {DragEvent} event Событие перетаскивания
         * @returns {void}
         */
        onDragOver(event) {
            if (this.$root.loggedIn && event.dataTransfer?.types?.includes("Files")) {
                event.preventDefault();
            }
        },

        /**
         * Файл compose, брошенный в окно, открывает слой с его содержимым
         * @param {DragEvent} event Событие сброса
         * @returns {Promise<void>}
         */
        async onDrop(event) {
            if (!this.$root.loggedIn) {
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
         * @param {EventTarget} target Цель события
         * @returns {boolean} Признак поля ввода
         */
        isEditableTarget(target) {
            const element = target instanceof HTMLElement ? target : null;

            if (!element) {
                return false;
            }

            return element.isContentEditable
                || [ "INPUT", "TEXTAREA", "SELECT" ].includes(element.tagName);
        },

        /**
         * Похоже ли вставленное на стек: только тогда стоит перехватывать вставку
         * @param {string} text Вставленный текст
         * @returns {boolean} Признак compose или команды docker run
         */
        looksLikeStack(text) {
            return /^\s*(sudo\s+)?docker\s+run\b/.test(text) || /^\s*services\s*:/m.test(text);
        },

        scanFolder() {
            this.$root.emitAgent(ALL_ENDPOINTS, "requestStackList", (res) => {
                this.$root.toastRes(res);
            });
        },
    },

};
</script>

<style lang="scss" scoped>
// Оболочка читает только токены: тема меняется вместе с ними, поэтому блока
// `.dark` здесь больше нет.

.app-header {
    background-color: var(--surface-panel);
    border-bottom: 1px solid var(--line-hair);
}

.brand {
    color: var(--text-strong);
}

.title {
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
}

main {
    min-height: calc(100vh - 160px);
}

.app-nav {
    margin-right: 25px;
    gap: var(--gap-md);
    align-items: center;
}

// Вкладка: активную показывает подчёркивание, а не рамка-таблетка. Цвет не
// единственный признак - подчёркивание видно и без различения цветов.
.tab {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-sm);
    min-height: var(--control-height);
    padding: 0 var(--gap-sm);
    color: var(--text-muted);
    text-decoration: none;
    border-bottom: 2px solid transparent;

    &:hover {
        color: var(--text-strong);
    }

    &.router-link-exact-active {
        color: var(--text-strong);
        border-bottom-color: var(--accent);
        font-weight: 500;
    }
}

// Обрыв связи - отказ, а не украшение: слово несёт смысл, цвет только помогает.
.lost-connection {
    padding: var(--gap-sm);
    background-color: var(--surface-panel);
    color: var(--state-failed);
    border-bottom: 2px solid var(--state-failed);
    position: fixed;
    width: 100%;
    z-index: 99999;
}

// Profile Pic Button with Dropdown
.dropdown-profile-pic {
    user-select: none;

    .profile-trigger {
        cursor: pointer;
        display: flex;
        gap: var(--gap-xs);
        align-items: center;
        min-height: var(--control-height);
        padding: 0 var(--gap-sm);
        color: var(--text-muted);
        background-color: transparent;
        border: 1px solid transparent;
        border-radius: var(--radius-control);

        &:hover {
            color: var(--text-strong);
            background-color: var(--surface-raised);
        }
    }

    .dropdown-menu {
        transition: all 0.2s;
        padding-left: 0;
        padding-bottom: 0;
        margin-top: var(--gap-sm) !important;
        overflow: hidden;

        .dropdown-divider {
            margin: 0;
            border-top: 1px solid var(--line-hair);
            background-color: transparent;
        }

        .dropdown-item-text {
            font-size: var(--text-base);
            padding-bottom: 0.7rem;
        }

        .dropdown-item {
            padding: 0.7rem 1rem;
        }
    }

    .profile-pic {
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-on-accent);
        background-color: var(--accent);
        width: 24px;
        height: 24px;
        margin-right: 5px;
        border-radius: var(--radius-pill);
        font-weight: 600;
        font-size: var(--text-xs);
    }
}
</style>
