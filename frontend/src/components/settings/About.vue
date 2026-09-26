<template>
    <!-- Automatic checks, release channel, and manual checks are independent controls. -->
    <section class="panel">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="box" />{{ $t("about") }}</h2>
        </div>

        <div class="panel-body about-body">
            <div class="brand">
                <span class="brand-tile" aria-hidden="true"><InterfaceIcon name="box" /></span>
                <div class="brand-text">
                    <p class="wordmark"><BrandMark /></p>
                    <p class="versions">{{ $t("version") }} {{ $root.info.version }} · {{ $t("frontendVersion") }} {{ $root.frontendVersion }}</p>
                </div>
            </div>

            <p v-if="!$root.isFrontendBackendVersionMatched" class="alert alert-warning" role="alert">
                <font-awesome-icon icon="triangle-exclamation" />{{ $t("frontendVersionMismatch") }}
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
                    <button class="btn" :class="panelUpdateLeads ? 'btn-normal' : 'btn-primary'" type="button" :disabled="busy || !settingsLoaded" :aria-busy="checking" @click="checkNow">
                        <InterfaceIcon name="refresh" />
                        {{ $t(checking ? "updateChecking" : "updateCheckNow") }}
                    </button>
                </div>

                <div class="update-result" role="status" aria-live="polite" aria-atomic="true">
                    <p v-if="checking" class="update-state">{{ $t("updateChecking") }}</p>
                    <p v-else-if="checkFailed || notice === 'failed'" class="text-danger">{{ $t(checkErrorKey) }}</p>
                    <p v-else-if="notice === 'available'" class="update-news">
                        <font-awesome-icon icon="arrow-alt-circle-up" />
                        <span>{{ $t("newUpdate") }}: {{ versionInfo.latestVersion }}</span>
                    </p>
                    <p v-else-if="notice === 'stale'" class="update-state">{{ $t("updateCheckStale") }}</p>
                    <p v-else-if="notice === 'current'" class="update-state">{{ $t("updateCurrent") }}</p>
                    <p v-else class="update-state">{{ $t("updateNotChecked") }}</p>
                </div>
                <p v-if="versionInfo.lastUpdateCheck" class="update-state">{{ $t("updateLastChecked") }}: {{ lastChecked }}</p>

                <!-- The update of the panel itself: dry run, password, then the overlay of the layout -->
                <div v-if="$root.isAdmin && panelNode" class="panel-update-flow">
                    <template v-if="panelNode.name === 'idle'">
                        <p v-if="idleNotice" class="update-notice" role="status">{{ $t(idleNotice) }}</p>
                        <div v-if="panelNode.sub === 'available'" class="update-actions">
                            <button class="btn btn-primary" type="button" :disabled="!panelOnline" @click="$root.panelUpdateCheck()">
                                {{ $t("panelUpdatePreviewButton", { version: panelNode.version }) }}
                            </button>
                        </div>
                    </template>

                    <template v-else-if="panelNode.name === 'preview'">
                        <template v-if="panelNode.sub === 'checking'">
                            <p class="update-state" role="status">
                                <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                                {{ $t("panelUpdateChecking") }}
                            </p>
                            <p v-if="panelNode.quiet" class="update-notice">{{ $t("panelUpdateCheckSlow") }}</p>
                        </template>
                        <template v-else-if="panelNode.sub === 'ready'">
                            <h4 class="preview-title" role="status">{{ $t("panelUpdateReadyTitle", { from: panelNode.from, to: panelNode.to }) }}</h4>
                            <p class="update-state">{{ previewFields }}</p>
                            <p v-if="panelNode.preview?.schemaChanges" class="update-warning">{{ $t("panelUpdateSchemaWarning") }}</p>
                            <p v-if="expiresAt" class="update-state update-expires">{{ $t("panelUpdateExpires", { time: expiresAt }) }}</p>
                            <p v-if="panelNode.notice === 'not-started'" class="update-notice">{{ $t("panelUpdateNotStarted") }}</p>
                        </template>
                        <template v-else>
                            <h4 class="preview-title" role="status">{{ $t("panelUpdateRefusedTitle") }}</h4>
                            <p class="update-state">{{ refusalText }}</p>
                            <p v-if="panelNode.refusal?.error" class="update-state">{{ $t("panelUpdateErrorDetail") }}: <code>{{ panelNode.refusal.error }}</code></p>
                        </template>
                        <div class="update-actions">
                            <button v-if="panelNode.sub === 'ready'" class="btn btn-primary" type="button" @click="$root.panelUpdateConfirm()">
                                {{ $t("panelUpdateApply", { version: panelNode.to }) }}
                            </button>
                            <button class="btn btn-normal" type="button" @click="$root.panelUpdateClose()">{{ $t("close") }}</button>
                        </div>
                    </template>

                    <p v-else-if="panelNode.name === 'running'" class="update-state">{{ $t("panelUpdateInProgress", { version: panelNode.to }) }}</p>

                    <!-- When the panel cannot update itself, the host can -->
                    <div v-if="hostVersion" class="panel-update-host">
                        <h4 class="preview-title">{{ $t("panelUpdateHostTitle") }}</h4>
                        <p v-if="hostReason" class="update-state">{{ $t(hostReason) }}</p>
                        <p class="update-state">{{ $t("panelUpdateHostHint") }}</p>
                        <pre v-for="command in hostCommands" :key="command" class="host-command"><code>{{ command }}</code></pre>
                        <p v-if="!installDir" class="update-state">{{ $t("panelUpdateHostDir", { dir: placeholder }) }}</p>
                        <i18n-t scope="global" keypath="panelUpdateOldInstall" tag="p" class="update-state">
                            <template #guide>
                                <a href="https://github.com/mazixs/dockge2/blob/main/docs/updating.md" target="_blank" rel="noopener noreferrer">{{ $t("panelUpdateGuideLink") }}</a>
                            </template>
                        </i18n-t>
                    </div>
                </div>
            </div>

            <PanelContainerCard v-if="$root.isAdmin" />
        </div>

        <p class="panel-foot">
            <a class="repository-link" href="https://github.com/mazixs/dockge2" target="_blank" rel="noopener noreferrer">{{ $t("updateRepository") }}</a>
        </p>

        <!-- The password confirms the owner once more; it goes into the request and nowhere else -->
        <BModal :modelValue="passwordOpen" :title="$t('panelUpdatePasswordTitle')" :okTitle="$t('panelUpdateApplyShort')" :cancelTitle="$t('cancel')" :okDisabled="!password || passwordOffline" @update:model-value="onPasswordToggle" @ok="submitPassword" @hidden="password = ''">
            <form class="password-form" @submit.prevent="submitPassword">
                <p>{{ $t("panelUpdatePasswordHint", { from: passwordFrom, to: passwordTo }) }}</p>
                <p v-if="passwordNotice" class="text-danger" role="alert">{{ passwordNotice }}</p>
                <p v-else-if="passwordOffline" class="text-danger" role="alert">{{ $t("panelUpdateOffline") }}</p>
                <label for="panel-update-password" class="form-label">{{ $t("password") }}</label>
                <input id="panel-update-password" v-model="password" type="password" class="form-control" autocomplete="current-password" required />
            </form>
        </BModal>
    </section>
</template>

<script lang="ts">
import { defineComponent, type ComponentPublicInstance } from "vue";
import BrandMark from "../BrandMark.vue";
import { formatMoment } from "../../format";
import InterfaceIcon from "../InterfaceIcon.vue";
import PanelContainerCard from "./PanelContainerCard.vue";
import { UPDATE_CHECK_MESSAGES, type UpdateCheckError } from "../../../../common/update-check";
import { updateNotice, type UpdateNotice, type VersionInfo } from "../../update-notice";
import { PANEL_UPDATE_DIR_PLACEHOLDER, panelUpdateCommands, type PanelUpdateNode } from "../../panel-update-machine";
import type { GeneralSettings, SettingsPageApi, SettingsResponse } from "../../pages/Settings.vue";

/** Refusals the host can get past with the updater: the host block explains how */
const HOST_CODES = [ "updater-missing", "updater-outdated", "unmanaged" ];

/**
 * The answer of a manual update check, which the socket carries untyped. A refusal of
 * the handler itself has a message and no code
 */
interface UpdateCheckAnswer extends VersionInfo {
    ok? : boolean;
    msg? : string;
    code? : UpdateCheckError;
}

/**
 * The settings page this section is rendered in: the router view and its transition
 * stand between them
 * @param parent Parent of the section
 * @returns The page
 */
function settingsPage(parent : ComponentPublicInstance | null) : SettingsPageApi {
    const page = parent?.$parent?.$parent;
    if (!page || !("settings" in page)) {
        throw new Error("A settings section is rendered outside the settings page");
    }
    return page as ComponentPublicInstance & SettingsPageApi;
}

export default defineComponent({
    components: { BrandMark,
        InterfaceIcon,
        PanelContainerCard },
    data() {
        return {
            checking: false,
            saving: false,
            checkFailed: false,
            manualErrorKey: "",
            disposed: false,
            manualInfo: null as VersionInfo | null,
            /** Typed into the dialog and handed to the apply request once */
            password: "",
        };
    },
    computed: {
        checkErrorKey() : string {
            const code = this.versionInfo.updateCheckError;
            return this.manualErrorKey || (code && UPDATE_CHECK_MESSAGES[code]) || "updateCheckFailed";
        },
        busy() : boolean {
            return this.checking || this.saving;
        },
        versionInfo() : VersionInfo {
            return this.manualInfo ?? this.$root.info;
        },
        /**
         * What may be said about updates right now
         * @returns One of "off", "pending", "current", "available"
         */
        notice() : UpdateNotice {
            return updateNotice(this.versionInfo, this.manualInfo ? true : this.settings.checkUpdate);
        },
        settings() : GeneralSettings {
            return settingsPage(this.$parent).settings;
        },

        settingsLoaded() : boolean {
            return settingsPage(this.$parent).settingsLoaded;
        },

        panelNode() : PanelUpdateNode | null {
            return this.$root.panelUpdate?.node ?? null;
        },
        /** Once a release can be installed from here, installing it is the main action */
        panelUpdateLeads() : boolean {
            const node = this.panelNode;
            return this.$root.isAdmin && (node?.name === "preview" || (node?.name === "idle" && node.sub === "available"));
        },
        panelOnline() : boolean {
            return this.$root.panelUpdate?.ctx.link.kind === "online";
        },
        idleNotice() : string {
            const notice = this.panelNode?.name === "idle" ? this.panelNode.notice : null;
            if (notice === "preview-expired") {
                return "panelUpdatePreviewExpired";
            }
            if (notice === "not-started") {
                return "panelUpdateNotStarted";
            }
            return notice === "unreadable" ? "panelUpdateError.unreadable" : "";
        },
        previewFields() : string {
            const fields = this.panelNode?.name === "preview" ? this.panelNode.preview?.fields ?? [] : [];
            return fields.length > 0 ? this.$t("panelUpdateFields", { fields: fields.join(", ") }) : this.$t("panelUpdateNoFields");
        },
        lastChecked() : string {
            return formatMoment(this.versionInfo.lastUpdateCheck, this.$i18n.locale);
        },
        expiresAt() : string {
            const expires = this.panelNode?.name === "preview" ? this.panelNode.expires : null;
            return formatMoment(expires, this.$i18n.locale, { hour: "2-digit",
                minute: "2-digit" });
        },
        /**
         * Why the dry run was refused, from the most precise text there is
         * @returns Text to show
         */
        refusalText() : string {
            const refusal = this.panelNode?.name === "preview" ? this.panelNode.refusal : null;
            if (!refusal || refusal.kind === "lost") {
                return this.$t("panelUpdateReason.lost");
            }
            const keys = refusal.kind === "error"
                ? [ refusal.msg, `panelUpdateError.${refusal.code}` ]
                : [ refusal.code && `panelUpdateReason.${refusal.code}`, refusal.outcome && `panelUpdateResult.${refusal.outcome}` ];
            const key = keys.find((candidate) => candidate && this.$te(candidate));
            return this.$t(key || "panelUpdateFailed");
        },
        /**
         * The release the host commands install, when the panel cannot do it itself
         * @returns Version, or empty when the host block is not needed
         */
        hostVersion() : string {
            const node = this.panelNode;
            if (node?.name === "idle" && node.sub === "manual" && this.notice === "available") {
                return this.versionInfo.latestVersion || "";
            }
            if (node?.name === "preview" && node.sub === "refused" && HOST_CODES.includes(node.refusal?.code ?? "")) {
                return node.to;
            }
            return "";
        },
        hostReason() : string {
            const node = this.panelNode;
            return node?.name === "idle" && node.reason ? `panelUpdateReason.${node.reason}` : "";
        },
        installDir() : string | undefined {
            return this.$root.panelUpdate?.ctx.status?.panel.installDir;
        },
        hostCommands() : string[] {
            return panelUpdateCommands("manual", this.installDir, this.hostVersion);
        },
        placeholder() : string {
            return PANEL_UPDATE_DIR_PLACEHOLDER;
        },
        passwordOpen() : boolean {
            return this.panelNode?.name === "preview" && this.panelNode.dialog;
        },
        passwordFrom() : string {
            return this.panelNode?.name === "preview" ? this.panelNode.from : "";
        },
        passwordTo() : string {
            return this.panelNode?.name === "preview" ? this.panelNode.to : "";
        },
        passwordOffline() : boolean {
            return this.passwordOpen && this.$root.panelUpdate?.ctx.link.kind !== "online";
        },
        passwordNotice() : string {
            const node = this.panelNode;
            if (node?.name !== "preview" || !node.notice || node.notice === "not-started") {
                return "";
            }
            const key = node.message && this.$te(node.message) ? node.message : `panelUpdateError.${node.notice}`;
            return this.$t(key);
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
            this.manualErrorKey = "";
            this.manualInfo = null;
            try {
                const result : UpdateCheckAnswer | undefined = await this.$root.getSocket().timeout(15000).emitWithAck("checkForUpdates");
                if (this.disposed) {
                    return;
                }
                if (result?.ok && typeof result.latestVersion === "string") {
                    this.manualInfo = { ...result,
                        lastUpdateCheck: new Date().toISOString(),
                        updateCheckFailed: false };
                    // With the notice switch off the info carries no release; this check found one
                    this.$root.panelUpdateInfo?.(result.latestVersion, result.updateAvailable === true);
                } else {
                    this.checkFailed = true;
                    this.manualErrorKey = result?.msg === "authPermissionDenied" || result?.msg === "notLoggedIn"
                        ? "authPermissionDenied"
                        : (result?.code && UPDATE_CHECK_MESSAGES[result.code]) || "updateCheckFailed";
                }
            } catch {
                this.checkFailed = true;
                this.manualErrorKey = "updateCheckConnection";
            } finally {
                this.checking = false;
            }
        },
        /**
         * Start the update with the password typed into the dialog
         * @param event The dialog's OK, cancelled while nothing was typed
         */
        submitPassword(event? : { preventDefault() : void }) {
            if (!this.password || this.passwordOffline) {
                event?.preventDefault();
                return;
            }
            const password = this.password;
            this.password = "";
            this.$root.panelUpdateSubmit(password);
            // Not started, as when the check expired a moment ago: the dialog stays with the reason
            if (this.passwordOpen) {
                event?.preventDefault();
            }
        },
        /**
         * The dialog closed by itself: Cancel, Escape or the backdrop
         * @param open Whether it is open now
         */
        onPasswordToggle(open : boolean) {
            if (!open && this.passwordOpen) {
                this.$root.panelUpdateClose();
            }
        },
        /** Save preferences before allowing a check to use the selected release channel. */
        async savePreferences() {
            this.saving = true;
            this.manualInfo = null;
            this.checkFailed = false;
            this.manualErrorKey = "";
            try {
                const result : SettingsResponse = await this.$root.getSocket().timeout(15000).emitWithAck("setSettings", this.settings, undefined);
                if (!this.disposed) {
                    this.$root.toastRes(result);
                }
            } catch {
                if (!this.disposed) {
                    this.$root.toastError("updatePreferencesFailed");
                }
            } finally {
                if (!this.disposed) {
                    settingsPage(this.$parent).loadSettings();
                }
                this.saving = false;
            }
        },
    },
});
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

.update-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-sm);
}

.update-state {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-faint);

    code {
        color: var(--text-strong);
        overflow-wrap: anywhere;
    }
}

.panel-update-flow,
.panel-update-host {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
}

.panel-update-flow {
    padding-top: var(--gap-md);
    border-top: 1px solid var(--line-hair);
}

.panel-update-flow:empty {
    display: none;
}

.preview-title {
    margin: 0;
    font-size: var(--text-md);
    line-height: var(--line-md);
    font-weight: var(--weight-strong);
    color: var(--text-strong);
}

.update-notice,
.update-warning {
    margin: 0;
    padding: var(--gap-sm) var(--gap-md);
    border-left: 3px solid var(--state-attention);
    background-color: color-mix(in srgb, var(--state-attention) 8%, transparent);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-strong);
}

.host-command {
    margin: 0;
    padding: var(--gap-sm) var(--gap-md);
    border-radius: var(--radius-control);
    background-color: var(--surface-sunken);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--line-code);
    color: var(--text-strong);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: all;
}

.password-form p {
    margin: 0 0 var(--gap-md);
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
