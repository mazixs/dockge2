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
        <header v-if="! $root.isMobile" class="d-flex flex-wrap justify-content-center py-3 mb-3 border-bottom">
            <router-link to="/" class="d-flex align-items-center mb-3 mb-md-0 me-md-auto text-dark text-decoration-none">
                <object class="bi me-2 ms-4" width="40" height="40" data="/icon.svg" />
                <span class="fs-4 title">Dockge</span>
            </router-link>

            <button v-if="$root.loggedIn" class="btn btn-primary me-3 create-stack-btn" type="button" @click="openCreateSheet()">
                <font-awesome-icon icon="plus" /> {{ $t("deployStackAction") }}
            </button>

            <a v-if="hasNewVersion" target="_blank" href="https://github.com/louislam/dockge/releases" class="btn btn-warning me-3">
                <font-awesome-icon icon="arrow-alt-circle-up" /> {{ $t("newUpdate") }}
            </a>

            <ul class="nav nav-pills">
                <li v-if="$root.loggedIn" class="nav-item me-2">
                    <router-link to="/" class="nav-link">
                        <font-awesome-icon icon="home" /> {{ $t("home") }}
                    </router-link>
                </li>

                <li v-if="$root.loggedIn" class="nav-item me-2">
                    <router-link to="/console" class="nav-link">
                        <font-awesome-icon icon="terminal" /> {{ $t("console") }}
                    </router-link>
                </li>

                <li v-if="$root.loggedIn" class="nav-item">
                    <div class="dropdown dropdown-profile-pic">
                        <div class="nav-link" data-bs-toggle="dropdown">
                            <div class="profile-pic">{{ $root.usernameFirstChar }}</div>
                            <font-awesome-icon icon="angle-down" />
                        </div>

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
@use "../styles/vars.scss" as *;

.nav-link {
    &.status-page {
        background-color: rgba(255, 255, 255, 0.1);
    }
}

.bottom-nav {
    z-index: 1000;
    position: fixed;
    bottom: 0;
    height: calc(60px + env(safe-area-inset-bottom));
    width: 100%;
    left: 0;
    background-color: #fff;
    box-shadow: 0 15px 47px 0 rgba(0, 0, 0, 0.05), 0 5px 14px 0 rgba(0, 0, 0, 0.05);
    text-align: center;
    white-space: nowrap;
    padding: 0 10px env(safe-area-inset-bottom);

    a {
        text-align: center;
        width: 25%;
        display: inline-block;
        height: 100%;
        padding: 8px 10px 0;
        font-size: 13px;
        color: #c1c1c1;
        overflow: hidden;
        text-decoration: none;

        &.router-link-exact-active, &.active {
            color: $primary;
            font-weight: bold;
        }

        div {
            font-size: 20px;
        }
    }
}

main {
    min-height: calc(100vh - 160px);
}

.title {
    font-weight: bold;
}

.nav {
    margin-right: 25px;
}

.lost-connection {
    padding: 5px;
    background-color: crimson;
    color: white;
    position: fixed;
    width: 100%;
    z-index: 99999;
}

// Profile Pic Button with Dropdown
.dropdown-profile-pic {
    user-select: none;

    .nav-link {
        cursor: pointer;
        display: flex;
        gap: 6px;
        align-items: center;
        background-color: rgba(200, 200, 200, 0.2);
        padding: 0.5rem 0.8rem;

        &:hover {
            background-color: rgba(255, 255, 255, 0.2);
        }
    }

    .dropdown-menu {
        transition: all 0.2s;
        padding-left: 0;
        padding-bottom: 0;
        margin-top: 8px !important;
        border-radius: 16px;
        overflow: hidden;

        .dropdown-divider {
            margin: 0;
            border-top: 1px solid rgba(0, 0, 0, 0.4);
            background-color: transparent;
        }

        .dropdown-item-text {
            font-size: 14px;
            padding-bottom: 0.7rem;
        }

        .dropdown-item {
            padding: 0.7rem 1rem;
        }

        .dark & {
            background-color: $dark-bg;
            color: $dark-font-color;
            border-color: $dark-border-color;

            .dropdown-item {
                color: $dark-font-color;

                &.active {
                    color: $dark-font-color2;
                    background-color: $highlight !important;
                }

                &:hover {
                    background-color: $dark-bg2;
                }
            }
        }
    }

    .profile-pic {
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        background-color: $primary;
        width: 24px;
        height: 24px;
        margin-right: 5px;
        border-radius: var(--radius-pill);
        font-weight: bold;
        font-size: 10px;
    }
}

.dark {
    header {
        background-color: $dark-header-bg;
        border-bottom-color: $dark-header-bg !important;

        span {
            color: #f0f6fc;
        }
    }

    .bottom-nav {
        background-color: $dark-bg;
    }
}
</style>
