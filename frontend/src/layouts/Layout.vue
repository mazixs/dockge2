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
        <header v-if="! $root.isMobile" class="app-header">
            <router-link to="/" class="brand d-flex align-items-center text-decoration-none">
                <object class="bi me-2 ms-4" width="28" height="28" data="/icon.svg" />
                <span class="title">Dockge 2</span>
            </router-link>

            <button v-if="$root.loggedIn" class="btn btn-primary btn-sm ms-3 create-stack-btn" type="button" @click="openCreateSheet()">
                <font-awesome-icon icon="plus" /> {{ $t("deployStackAction") }}
            </button>

            <ul class="nav app-nav ms-3">
                <li v-if="$root.loggedIn" class="nav-item">
                    <!-- Вкладка «Стеки» остаётся выбранной и на стеке, и в редакторе -->
                    <router-link to="/" class="tab" :class="{ 'tab-current': onStacks }" :aria-current="onStacks ? 'page' : undefined">{{ $t("stacksTab") }}</router-link>
                </li>

                <li v-if="$root.loggedIn" class="nav-item">
                    <router-link to="/console" class="tab">{{ $t("console") }}</router-link>
                </li>

                <li v-if="$root.loggedIn" class="nav-item">
                    <router-link to="/settings/general" class="tab">{{ $t("Settings") }}</router-link>
                </li>
            </ul>

            <div class="header-right">
                <!-- Что происходит в хозяйстве: одна строка справа, как в макете -->
                <router-link
                    v-if="$root.loggedIn" class="tally-attention"
                    :class="{ zero: attentionNum === 0 }"
                    :to="{ path: '/', query: { filter: 'attention' } }"
                >
                    <i class="dot" aria-hidden="true"></i>{{ $t("tallyAttention", attentionNum) }}
                </router-link>

                <span v-if="$root.loggedIn" class="tally-quiet">{{ $t("tallyRunning", runningNum) }} · {{ $t("tallyStopped", stoppedNum) }}</span>

                <!-- Насколько свежий список: он обновляется сам, и это видно -->
                <span v-if="$root.loggedIn && listAgeSeconds !== null" class="tally-quiet">{{ $t("listUpdatedAgo", [ listAgeSeconds ]) }}</span>

                <a v-if="hasNewVersion" target="_blank" href="https://github.com/louislam/dockge/releases" class="btn btn-sm btn-normal">
                    <font-awesome-icon icon="arrow-alt-circle-up" /> {{ $t("newUpdate") }}
                </a>
            </div>

            <ul class="nav">
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
import { ALL_ENDPOINTS, ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING } from "../../../common/util-common";

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
            /** Тик раз в секунду, чтобы «обновлено N с назад» действительно шло */
            tick: 1,
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

        /** Сколько секунд назад приходил список, null пока он не приходил вовсе */
        listAgeSeconds() {
            if (!this.$root.stackListAt) {
                return null;
            }
            return this.tick && Math.max(Math.round((Date.now() - this.$root.stackListAt) / 1000), 0);
        },

        /** Находимся ли мы на стеках: список, инспектор и редактор - одна вкладка */
        onStacks() {
            const path = this.$route.path;
            return path === "/" || path.startsWith("/stack") || path.startsWith("/compose") || path.startsWith("/terminal");
        },

        /** Стеки всех агентов одним списком: счётчики считаются по всему хозяйству */
        allStacks() {
            return Object.values(this.$root.completeStackList);
        },

        runningNum() {
            return this.allStacks.filter((stack) => stack.status === RUNNING).length;
        },

        attentionNum() {
            return this.allStacks.filter((stack) => stack.status === ATTENTION).length;
        },

        stoppedNum() {
            return this.allStacks.filter((stack) => [ EXITED, CREATED_FILE, CREATED_STACK ].includes(stack.status)).length;
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
        this.ageTimer = setInterval(() => {
            this.tick += 1;
        }, 1000);

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
        clearInterval(this.ageTimer);
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

// Счётчики в шапке: точка плюс число со словом, ничего лишнего
// Правый край шапки: сначала то, что требует внимания, потом спокойные числа
.header-right {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    margin-left: auto;
    margin-right: var(--gap-md);
    font-size: var(--text-sm);
}

.tally-attention {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-strong);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;

    .dot {
        width: 8px;
        height: 8px;
        border-radius: var(--radius-pill);
        background-color: var(--state-attention);
        flex: none;
    }

    // Когда внимания не требует ничего, строка не должна кричать
    &.zero {
        color: var(--text-faint);
        font-weight: 400;

        .dot {
            background-color: var(--state-stopped);
        }
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.tally-quiet {
    color: var(--text-faint);
    font-size: var(--text-xs);
    white-space: nowrap;
}

@media (max-width: 1200px) {
    .tally-quiet {
        display: none;
    }
}
// Оболочка читает только токены: тема меняется вместе с ними, поэтому блока
// `.dark` здесь больше нет.

// Шапка плотная: одна линия с логотипом, кнопкой, вкладками и правым краем
.app-header {
    display: flex;
    align-items: center;
    background-color: var(--surface-panel);
    border-bottom: 1px solid var(--line-hair);
    padding: var(--gap-sm) 0;
    margin-bottom: var(--gap-md);

    .title {
        font-weight: 600;
        letter-spacing: -0.01em;
    }
}

.app-nav {
    gap: var(--gap-xs);
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

    &.router-link-exact-active, &.tab-current {
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
