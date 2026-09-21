<template>
    <!-- Automatic checks, release channel, and manual checks are independent controls. -->
    <section class="panel">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="box" />{{ $t("About") }}</h2>
        </div>

        <div class="panel-body about-body">
            <div class="brand">
                <span class="brand-tile" aria-hidden="true"><InterfaceIcon name="box" /></span>
                <div class="brand-text">
                    <p class="wordmark"><BrandMark /></p>
                    <p class="versions">{{ $t("Version") }} {{ $root.info.version }} · {{ $t("Frontend Version") }} {{ $root.frontendVersion }}</p>
                </div>
            </div>

            <p v-if="!$root.isFrontendBackendVersionMatched" class="alert alert-warning" role="alert">
                <font-awesome-icon icon="triangle-exclamation" />{{ $t("Frontend Version do not match backend version!") }}
            </p>

            <div class="field update-settings">
                <h3 class="form-label">{{ $t("aboutUpdates") }}</h3>

                <label class="update-option">
                    <input v-model="settings.checkUpdate" class="form-check-input" type="checkbox" :disabled="busy || !settingsLoaded" aria-labelledby="automatic-update-label" aria-describedby="automatic-update-hint" @change="savePreferences" />
                    <span>
                        <span id="automatic-update-label" class="option-label">{{ $t("updateAutomatic") }}</span>
                        <span id="automatic-update-hint" class="option-hint">{{ $t("updateAutomaticHint") }}</span>
                    </span>
                </label>
                <label class="update-option">
                    <input v-model="settings.checkBeta" class="form-check-input" type="checkbox" :disabled="busy || !settingsLoaded" aria-labelledby="beta-update-label" aria-describedby="beta-update-hint" @change="savePreferences" />
                    <span>
                        <span id="beta-update-label" class="option-label">{{ $t("updateIncludeBeta") }}</span>
                        <span id="beta-update-hint" class="option-hint">{{ $t("updateBetaHint") }}</span>
                    </span>
                </label>

                <div class="update-actions">
                    <button class="btn btn-primary" type="button" :disabled="busy || !settingsLoaded" :aria-busy="checking" @click="checkNow">
                        <InterfaceIcon name="refresh" />
                        {{ $t(checking ? "updateChecking" : "updateCheckNow") }}
                    </button>
                </div>

                <div class="update-result" role="status" aria-live="polite" aria-atomic="true">
                    <p v-if="checking" class="update-state">{{ $t("updateChecking") }}</p>
                    <p v-else-if="checkFailed" class="text-danger">{{ $t("updateCheckFailed") }}</p>
                    <p v-else-if="notice === 'available'" class="update-news">
                        <font-awesome-icon icon="arrow-alt-circle-up" />
                        <span>{{ $t("newUpdate") }}: {{ versionInfo.latestVersion }}</span>
                    </p>
                    <p v-else-if="notice === 'current'" class="update-state">{{ $t("updateCurrent") }}</p>
                    <p v-else class="update-state">{{ $t("updateNotChecked") }}</p>
                </div>
                <p v-if="!checking && !checkFailed && notice === 'available'" class="update-how">
                    {{ $t("updateHow") }} <code>./install.sh --update</code>
                </p>
            </div>
        </div>

        <p class="panel-foot">
            <a class="repository-link" href="https://github.com/mazixs/dockge2" target="_blank" rel="noopener noreferrer">{{ $t("updateRepository") }}</a>
        </p>
    </section>
</template>

<script>
import BrandMark from "../BrandMark.vue";
import InterfaceIcon from "../InterfaceIcon.vue";
import { updateNotice } from "../../update-notice";

export default {
    components: { BrandMark,
        InterfaceIcon },
    data() {
        return {
            checking: false,
            saving: false,
            checkFailed: false,
            disposed: false,
            manualInfo: /** @type {import("../../update-notice").VersionInfo | null} */ (null),
        };
    },
    computed: {
        busy() {
            return this.checking || this.saving;
        },
        versionInfo() {
            return this.manualInfo ?? this.$root.info;
        },
        /**
         * What may be said about updates right now
         * @returns {string} One of "off", "pending", "current", "available"
         */
        notice() {
            return updateNotice(this.versionInfo, this.manualInfo ? true : this.settings.checkUpdate);
        },
        settings() {
            return this.$parent.$parent.$parent.settings;
        },

        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
    },
    unmounted() {
        this.disposed = true;
    },
    methods: {
        /** Run a single check without enabling the automatic schedule. */
        async checkNow() {
            this.checking = true;
            this.checkFailed = false;
            this.manualInfo = null;
            try {
                const result = await this.$root.getSocket().timeout(15000).emitWithAck("checkForUpdates");
                if (this.disposed) {
                    return;
                }
                if (result?.ok && typeof result.latestVersion === "string") {
                    this.manualInfo = result;
                } else {
                    this.checkFailed = true;
                }
            } catch {
                this.checkFailed = true;
            } finally {
                this.checking = false;
            }
        },
        /** Save preferences before allowing a check to use the selected release channel. */
        async savePreferences() {
            this.saving = true;
            this.manualInfo = null;
            this.checkFailed = false;
            try {
                const result = await this.$root.getSocket().timeout(15000).emitWithAck("setSettings", this.settings, undefined);
                if (!this.disposed) {
                    this.$root.toastRes(result);
                }
            } catch {
                if (!this.disposed) {
                    this.$root.toastError(this.$t("updatePreferencesFailed"));
                }
            } finally {
                if (!this.disposed) {
                    this.$parent.$parent.$parent.loadSettings();
                }
                this.saving = false;
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.about-body {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}

.brand {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
}

// Знак продукта рисуется тем же контуром, что в шапке, а не файлом значка
// вкладки: у файла свой непрозрачный фон и своя зелень, и на панели он читался
// как чужая наклейка поверх темы
.brand-tile {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-card);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-title-sm);
}

.brand-text {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
}

.wordmark {
    margin: 0;
    font-size: var(--text-lg);
    line-height: var(--line-lg);
    font-weight: var(--weight-strong);
    color: var(--text-strong);
}

.versions {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-faint);
}

.alert {
    margin: 0;
}

// The news and the plain state sit in the same place, so the block does not jump
// when the answer arrives
.update-news {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
}

.update-state,
.update-how {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-faint);
}

.update-how code {
    color: var(--text-strong);
}

.update-settings {
    gap: var(--gap-lg);
}

.update-option {
    display: flex;
    align-items: flex-start;
    gap: var(--gap-md);
    cursor: pointer;

    input {
        flex: none;
        margin-top: .2em;
    }
}

.option-label,
.option-hint {
    display: block;
}

.option-hint {
    margin-top: var(--gap-xs);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.update-result p {
    margin: 0;
}

.update-news {
    color: var(--accent-text);
}

.repository-link {
    color: var(--text-muted);
    font-size: var(--text-sm);
}
</style>
