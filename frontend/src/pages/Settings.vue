<template>
    <!-- Настройки собраны как рабочая область стека: имя страницы, слева список
         разделов, справа колонка панелей. Разделы не вложены в общую коробку -
         панель внутри панели читалась бы как два уровня одного раздела -->
    <div class="page settings-page">
        <router-link v-if="$root.isMobile && currentPage" to="/settings" class="back-to-menu">
            <font-awesome-icon icon="chevron-left" />{{ $t("familiarAllSettings") }}
        </router-link>

        <h1 v-show="show">{{ $t("Settings") }}</h1>

        <div class="settings-layout">
            <nav v-if="showSubMenu" class="settings-menu" :aria-label="$t('Settings')">
                <template v-for="(group, groupIndex) in menuGroups" :key="groupIndex">
                    <hr v-if="groupIndex > 0" class="menu-split" />
                    <router-link v-for="item in group" :key="item.key" :to="`/settings/${item.key}`" class="menu-item">
                        {{ item.title }}
                    </router-link>
                </template>

                <!-- Выход стоит здесь только на узком экране: на широком он в шапке -->
                <a v-if="$root.loggedIn && !$root.authDisabled" class="menu-item logout d-lg-none" @click.prevent="$root.logout">
                    <font-awesome-icon icon="sign-out-alt" />{{ $t("Logout") }}
                </a>
            </nav>

            <div class="settings-content">
                <p v-if="currentPage && !subMenus[currentPage]" class="alert alert-warning" role="alert">{{ $t("familiarRestricted") }}</p>
                <router-view v-else v-slot="{ Component }">
                    <!-- Keep the wrapper: legacy settings children traverse it via $parent. -->
                    <transition :css="false">
                        <component :is="Component" />
                    </transition>
                </router-view>
            </div>
        </div>
    </div>
</template>

<script>
import { useRoute } from "vue-router";

export default {
    data() {
        return {
            show: true,
            settings: {},
            settingsLoaded: false,
        };
    },

    computed: {
        currentPage() {
            let pathSplit = useRoute().path.split("/");
            let pathEnd = pathSplit[pathSplit.length - 1];
            if (!pathEnd || pathEnd === "settings") {
                return null;
            }
            return pathEnd;
        },

        showSubMenu() {
            if (this.$root.isMobile) {
                return !this.currentPage;
            } else {
                return true;
            }
        },

        subMenus() {
            return {
                appearance: { title: this.$t("Appearance") },
                security: { title: this.$t("Security") },
                ...(this.$root.isAdmin ? {
                    general: { title: this.$t("general") },
                    users: { title: this.$t("familiarUsers") },
                    agents: { title: this.$t("dockgeAgent", 2) },
                    mcp: { title: this.$t("mcpTitle") },
                    globalEnv: { title: this.$t("GlobalEnv") },
                    about: { title: this.$t("About") },
                } : {}),
            };
        },

        /**
         * Разделы идут тремя группами: сначала то, что настраивает себе каждый,
         * потом сервер, потом справка. Линия между группами отвечает на вопрос,
         * почему список не отсортирован по алфавиту
         * @returns {Array<Array<{key: string, title: string}>>} Группы разделов
         */
        menuGroups() {
            const groups = [[ "appearance", "security" ], [ "general", "users", "agents", "mcp", "globalEnv" ], [ "about" ]];

            return groups
                .map((keys) => keys
                    .filter((key) => this.subMenus[key])
                    .map((key) => ({ key,
                        title: this.subMenus[key].title })))
                .filter((group) => group.length > 0);
        },
    },

    watch: {
        "$root.isMobile"() {
            this.loadGeneralPage();
        }
    },

    mounted() {
        this.loadSettings();
        this.loadGeneralPage();
    },

    methods: {

        /**
         * Load the general settings page
         * For desktop only, on mobile do nothing
         */
        loadGeneralPage() {
            if (!this.currentPage && !this.$root.isMobile) {
                this.$router.push("/settings/appearance");
            }
        },

        /** Load settings from server */
        loadSettings() {
            this.$root.getSocket().emit("getSettings", (res) => {
                if (!res?.ok) {
                    this.$root.toastRes(res);
                    return;
                }
                this.settings = res.data ?? {};
                // Проверка обновлений выключена, пока владелец не включил ее сам:
                // это исходящий запрос на GitHub, и панель не делает его молча
                if (this.settings.checkUpdate === undefined) {
                    this.settings.checkUpdate = false;
                }
                this.settingsLoaded = true;
            });
        },

        /**
         * Callback for saving settings
         * @callback saveSettingsCB
         * @param {Object} res Result of operation
         */

        /**
         * Save Settings
         * @param {saveSettingsCB} [callback]
         * @param {string} [currentPassword] Only need for disableAuth to true
         */
        saveSettings(callback, currentPassword) {
            let valid = this.validateSettings();
            if (valid.success) {
                this.$root.getSocket().emit("setSettings", this.settings, currentPassword, (res) => {
                    this.$root.toastRes(res);
                    this.loadSettings();

                    // Only on success: a refused save must not let the caller act as if
                    // the setting had been stored, for instance by clearing the session
                    if (callback && res?.ok) {
                        callback(res);
                    }
                });
            } else {
                this.$root.toastError(valid.msg);
            }
        },

        /**
         * Ensure settings are valid
         * @returns {Object} Contains success state and error msg
         */
        validateSettings() {
            if (this.settings.keepDataPeriodDays < 0) {
                return {
                    success: false,
                    msg: this.$t("dataRetentionTimeError"),
                };
            }
            return {
                success: true,
                msg: "",
            };
        },
    }
};
</script>

<style lang="scss" scoped>
.back-to-menu {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-sm);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-decoration: none;

    &:hover {
        color: var(--text-strong);
    }
}

.settings-layout {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: var(--gap-xl);
    align-items: start;
}

// Список разделов - та же рейка, что список стеков: выбранный отмечен
// заливкой и акцентным словом, а не рамкой
.settings-menu {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
    position: sticky;
    top: var(--gap-lg);
}

.menu-item {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    min-height: var(--control-height);
    padding: var(--gap-xs) var(--gap-md);
    border-radius: var(--radius-control);
    color: var(--text-muted);
    font-size: var(--text-sm);
    text-decoration: none;
    cursor: pointer;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);

    &:hover {
        background-color: var(--surface-raised);
        color: var(--text-strong);
    }
}

.menu-item.active,
.menu-item.router-link-active {
    background-color: var(--surface-raised);
    color: var(--accent-text);
    font-weight: var(--weight-medium);
}

// Линия между группами разделов: тонкая, в ширину рейки, без отступов вокруг
// пунктов - иначе она читалась бы как рамка блока
.menu-split {
    margin: var(--gap-sm) var(--gap-md);
    border: 0;
    border-top: 1px solid var(--line-hair);
    opacity: 1;
}

.logout {
    color: var(--state-failed);
}

// Панели раздела стоят колонкой с тем же шагом, что панели файлов. Ширина
// ограничена: в разделах только формы и списки, а форма шире 560 px не бывает,
// и растянутая на всю область панель оставляла справа полосу пустоты внутри себя
.settings-content {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
    min-width: 0;
    max-width: 720px;
}

.alert {
    margin: 0;
}

@media (max-width: 992px) {
    .settings-layout {
        grid-template-columns: minmax(0, 1fr);
    }

    .settings-menu {
        position: static;
    }
}

</style>
