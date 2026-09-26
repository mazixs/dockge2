<template>
    <!-- Безопасность разложена по панелям: учетная запись, второй фактор,
         отключение входа и консоль. Каждая говорит, что именно она меняет -->
    <div v-if="settingsLoaded" class="security">
        <section v-if="!settings.disableAuth" class="panel">
            <div class="panel-bar">
                <h2 class="panel-title"><InterfaceIcon name="lock" />{{ $t("securityAccount") }}</h2>
                <span class="panel-meta">{{ $root.username }}</span>
            </div>

            <form class="panel-body form-stack" @submit.prevent="savePassword">
                <div class="field">
                    <label for="current-password" class="form-label">{{ $t("currentPassword") }}</label>
                    <input
                        id="current-password"
                        v-model="password.currentPassword"
                        type="password"
                        class="form-control"
                        autocomplete="current-password"
                        required
                    />
                </div>

                <div class="field">
                    <label for="new-password" class="form-label">{{ $t("newPassword") }}</label>
                    <input
                        id="new-password"
                        v-model="password.newPassword"
                        type="password"
                        class="form-control"
                        autocomplete="new-password"
                        required
                    />
                </div>

                <div class="field">
                    <label for="repeat-new-password" class="form-label">{{ $t("repeatNewPassword") }}</label>
                    <input
                        id="repeat-new-password"
                        v-model="password.repeatNewPassword"
                        type="password"
                        class="form-control"
                        :class="{ 'is-invalid': invalidPassword }"
                        autocomplete="new-password"
                        required
                    />
                    <div class="invalid-feedback">{{ $t("passwordNotMatchMsg") }}</div>
                </div>

                <div class="actions">
                    <button class="btn btn-primary" type="submit" :disabled="processing">
                        <div v-if="processing" class="spinner-border spinner-border-sm"></div>
                        {{ $t("updatePassword") }}
                    </button>
                    <button id="logout-btn" class="btn btn-normal btn-danger-text" type="button" @click="$root.logout">{{ $t("logout") }}</button>
                </div>
            </form>
        </section>

        <section v-if="!settings.disableAuth" class="panel">
            <div class="panel-bar">
                <h2 class="panel-title"><ShieldCheck />{{ $t("twoFactorAuthentication") }}</h2>
            </div>

            <div class="panel-body form-stack">
                <p class="form-text">{{ $t("securityTwoFactorHint") }}</p>
                <div class="actions">
                    <button class="btn btn-normal" type="button" @click="showTwoFADialog">{{ $t("twoFactorSettings") }}</button>
                </div>
            </div>
        </section>

        <section v-if="$root.isAdmin" class="panel">
            <div class="panel-bar">
                <!-- Панель называется тем, что в ней делают: "Расширенные" не говорило
                     ни о входе, ни о том, что кнопка внутри одна -->
                <h2 class="panel-title"><InterfaceIcon name="key" />{{ $t("securitySignIn") }}</h2>
            </div>

            <div class="panel-body form-stack">
                <p class="form-text">{{ $t("securityAdvancedHint") }}</p>
                <div class="actions">
                    <button v-if="settings.disableAuth" id="enableAuth-btn" class="btn btn-normal" @click="enableAuth">{{ $t("enableAuthButton") }}</button>
                    <button v-else id="disableAuth-btn" class="btn btn-normal btn-danger-text" @click="confirmDisableAuth">{{ $t("disableAuthButton") }}</button>
                </div>
            </div>
        </section>

        <!-- The console of this server only: an agent turns its own console on in its own panel -->
        <section v-if="$root.isAdmin" class="panel console-access">
            <div class="panel-bar">
                <h2 class="panel-title"><InterfaceIcon name="terminal" />{{ $t("console") }}</h2>
                <span v-if="consoleState" class="panel-meta">{{ consoleStateLabel }}</span>
            </div>

            <div class="panel-body form-stack">
                <p class="form-text">{{ $t("securityConsoleHint") }}</p>
                <div v-if="consoleState" class="actions">
                    <button v-if="consoleState.enabled" id="console-off-btn" class="btn btn-normal" type="button" :disabled="consoleProcessing" @click="setConsole(false)">{{ $t("consoleTurnOff") }}</button>
                    <button v-else id="console-on-btn" class="btn btn-normal btn-danger-text" type="button" :disabled="consoleProcessing" @click="askConsole('enable')">{{ $t("consoleTurnOn") }}</button>
                </div>

                <template v-if="consoleState?.enabled">
                    <p class="form-text">{{ $t(consoleState.operators ? "consoleAccessOperators" : "consoleAccessOwners") }}</p>
                    <div class="actions">
                        <button v-if="consoleState.operators" id="console-owners-btn" class="btn btn-normal" type="button" :disabled="consoleProcessing" @click="setConsoleOperators(false)">{{ $t("consoleOwnersOnlyAction") }}</button>
                        <button v-else id="console-operators-btn" class="btn btn-normal btn-danger-text" type="button" :disabled="consoleProcessing" @click="askConsole('operators')">{{ $t("consoleAllowOperators") }}</button>
                    </div>
                </template>
            </div>
        </section>

        <!-- Containers outside the stacks directory of this server; an agent decides for its own -->
        <section v-if="$root.isAdmin" class="panel container-control">
            <div class="panel-bar">
                <h2 class="panel-title"><InterfaceIcon name="box" />{{ $t("containerControlTitle") }}</h2>
                <span class="panel-meta">{{ $t(containerControl ? "consoleStateOn" : "consoleStateOff") }}</span>
            </div>

            <div class="panel-body form-stack">
                <p class="form-text">{{ $t("containerControlHint") }}</p>
                <div class="actions">
                    <button v-if="containerControl" id="container-control-off-btn" class="btn btn-normal" type="button" :disabled="containerControlProcessing" @click="setContainerControl(false)">{{ $t("containerControlTurnOff") }}</button>
                    <button v-else id="container-control-on-btn" class="btn btn-normal btn-danger-text" type="button" :disabled="containerControlProcessing" @click="askContainerControl">{{ $t("containerControlTurnOn") }}</button>
                </div>
            </div>
        </section>

        <TwoFADialog ref="TwoFADialog" />

        <Confirm ref="confirmContainerControl" btn-style="btn-danger" :yes-text="$t('containerControlTurnOn')" :no-text="$t('cancel')" @yes="setContainerControl(true)" @no="containerControlPassword = ''">
            <p>{{ $t("containerControlConfirm") }}</p>

            <div class="field">
                <label for="container-control-password" class="form-label">{{ $t("currentPassword") }}</label>
                <input
                    id="container-control-password"
                    v-model="containerControlPassword"
                    type="password"
                    class="form-control"
                    autocomplete="current-password"
                    required
                />
            </div>
        </Confirm>

        <Confirm ref="confirmConsole" btn-style="btn-danger" :yes-text="$t(consoleAction === 'operators' ? 'consoleAllowOperators' : 'consoleTurnOn')" :no-text="$t('cancel')" @yes="confirmConsole" @no="consolePassword = ''">
            <p>{{ $t(consoleAction === "operators" ? "consoleAllowOperatorsConfirm" : "consoleTurnOnConfirm") }}</p>

            <div class="field">
                <label for="console-password" class="form-label">{{ $t("currentPassword") }}</label>
                <input
                    id="console-password"
                    v-model="consolePassword"
                    type="password"
                    class="form-control"
                    autocomplete="current-password"
                    required
                />
            </div>
        </Confirm>

        <Confirm ref="confirmDisableAuth" btn-style="btn-danger" :yes-text="$t('disableAuthConfirm')" :no-text="$t('leave')" @yes="disableAuth">
            <i18n-t scope="global" keypath="disableAuthMessage1" tag="p">
                <template #disableAuth>
                    <strong>{{ $t('disableAuth') }}</strong>
                </template>
            </i18n-t>

            <i18n-t scope="global" keypath="disableAuthMessage2" tag="p">
                <template #scenarios>
                    <strong>{{ $t('scenarios') }}</strong>
                </template>
            </i18n-t>

            <p>{{ $t("disableAuthCareful") }}</p>

            <div class="field">
                <label for="current-password2" class="form-label">{{ $t("currentPassword") }}</label>
                <input
                    id="current-password2"
                    v-model="password.currentPassword"
                    type="password"
                    class="form-control"
                    required
                />
            </div>
        </Confirm>
    </div>
</template>

<script lang="ts">
import { defineComponent, type ComponentPublicInstance } from "vue";
import Confirm from "../../components/Confirm.vue";
import TwoFADialog from "../../components/TwoFADialog.vue";
import InterfaceIcon from "../InterfaceIcon.vue";
import ShieldCheck from "../ShieldCheck.vue";
import { authClient } from "../../auth-client";
import { authErrorMessage, passwordChangeRequest } from "../../auth-messages";
import type { GeneralSettings, SettingsPageApi, SettingsResponse } from "../../pages/Settings.vue";
import { SET_CONTAINER_CONTROL_EVENT } from "../../../../common/types/container";

/** Whether the console of this server is on and who may open it */
interface ConsoleState {
    enabled : boolean;
    operators : boolean;
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
    components: {
        Confirm,
        TwoFADialog,
        InterfaceIcon,
        ShieldCheck,
    },

    data() {
        return {
            invalidPassword: false,
            processing: false,
            password: {
                currentPassword: "",
                newPassword: "",
                repeatNewPassword: "",
            },
            consoleState: null as ConsoleState | null,
            /** What the password dialog confirms: turning the console on, or letting operators in */
            consoleAction: "enable" as "enable" | "operators",
            consolePassword: "",
            consoleProcessing: false,
            containerControlPassword: "",
            containerControlProcessing: false,
        };
    },

    computed: {
        settings() : GeneralSettings {
            return settingsPage(this.$parent).settings;
        },
        saveSettings() : SettingsPageApi["saveSettings"] {
            return settingsPage(this.$parent).saveSettings;
        },
        settingsLoaded() : boolean {
            return settingsPage(this.$parent).settingsLoaded;
        },
        /** Whether operators may control unmanaged containers here, as the last stack list said */
        containerControl() : boolean {
            return this.$root.hostContainers[""]?.containerControl === true;
        },
        consoleStateLabel() : string {
            return this.$t(this.consoleState?.enabled ? "consoleStateOn" : "consoleStateOff");
        },
    },

    watch: {
        "password.repeatNewPassword"() {
            this.invalidPassword = false;
        },
        "$root.isAdmin": {
            immediate: true,
            handler(isAdmin : boolean) {
                if (isAdmin) {
                    this.loadConsoleState();
                }
            },
        },
    },

    methods: {
        /** Check new passwords match before saving them */
        async savePassword() {
            if (this.password.newPassword !== this.password.repeatNewPassword) {
                this.invalidPassword = true;
                return;
            }

            this.processing = true;

            try {
                // Other sessions are revoked, so a stolen cookie stops working
                const { error } = await authClient.changePassword(
                    passwordChangeRequest(this.password.currentPassword, this.password.newPassword),
                );

                if (error) {
                    this.$root.toastError(authErrorMessage(error));
                    return;
                }

                // Revoking the other sessions replaces this one too, and the socket was
                // identified with the cookie of the old session, so it has to shake
                // hands again or every later password confirmation would be refused
                await this.$root.reconnectSocket();

                this.$root.toastSuccess("saved");
                this.password.currentPassword = "";
                this.password.newPassword = "";
                this.password.repeatNewPassword = "";
            } finally {
                this.processing = false;
            }
        },

        /** Disable authentication for web app access */
        disableAuth() {
            this.settings.disableAuth = true;

            // The password is only needed for this direction, and the callback runs on
            // success only, so a refused confirmation leaves the screen as it was
            this.saveSettings(() => {
                this.password.currentPassword = "";
                location.reload();
            }, this.password.currentPassword);
        },

        /** Enable authentication for web app access */
        enableAuth() {
            this.settings.disableAuth = false;
            this.saveSettings(() => location.reload());
        },

        /** Open the dialog that sets up the second factor */
        showTwoFADialog() {
            (this.$refs.TwoFADialog as InstanceType<typeof TwoFADialog>).show();
        },

        /** Show confirmation dialog for disable auth */
        confirmDisableAuth() {
            (this.$refs.confirmDisableAuth as InstanceType<typeof Confirm>).show();
        },

        /** Read whether the console of this server is on and who may open it */
        async loadConsoleState() {
            const res = await this.$root.emitAgentRequest("", "checkMainTerminal", []);
            this.consoleState = "msg" in res && res.msg ? null : { enabled: res.ok,
                operators: Boolean("operators" in res && res.operators) };
        },

        /**
         * Ask for the password before a change that widens access to the console
         * @param action What the dialog confirms
         */
        askConsole(action : "enable" | "operators") {
            this.consoleAction = action;
            (this.$refs.confirmConsole as InstanceType<typeof Confirm>).show();
        },

        /** Apply what the password dialog confirmed */
        confirmConsole() {
            if (this.consoleAction === "operators") {
                this.setConsoleOperators(true);
            } else {
                this.setConsole(true);
            }
        },

        /**
         * Turn the console on, with the password, or off
         * @param enabled Whether the console should be on
         */
        setConsole(enabled : boolean) {
            this.consoleProcessing = true;
            this.$root.getSocket().emit("setConsoleEnabled", enabled, enabled ? this.consolePassword : "", (res : SettingsResponse) => {
                this.consoleProcessing = false;
                this.consolePassword = "";
                this.$root.toastRes(res);
                if (res.ok) {
                    this.consoleState = { operators: false,
                        ...this.consoleState,
                        enabled };
                }
            });
        },

        /**
         * Let operators open the console, with the password, or limit it to owners again
         * @param allowed Whether operators may open it
         */
        setConsoleOperators(allowed : boolean) {
            this.consoleProcessing = true;
            this.$root.getSocket().emit("setConsoleOperators", allowed, allowed ? this.consolePassword : "", (res : SettingsResponse) => {
                this.consoleProcessing = false;
                this.consolePassword = "";
                this.$root.toastRes(res);
                if (res.ok) {
                    this.consoleState = { enabled: false,
                        ...this.consoleState,
                        operators: allowed };
                }
            });
        },

        /** Ask for the password before operators may control containers the panel does not manage */
        askContainerControl() {
            (this.$refs.confirmContainerControl as InstanceType<typeof Confirm>).show();
        },

        /**
         * Let operators start, stop and restart unmanaged containers, with the password, or stop them
         * @param enabled Whether they may
         */
        setContainerControl(enabled : boolean) {
            this.containerControlProcessing = true;
            this.$root.getSocket().emit(SET_CONTAINER_CONTROL_EVENT, enabled, enabled ? this.containerControlPassword : "", (res : SettingsResponse) => {
                this.containerControlProcessing = false;
                this.containerControlPassword = "";
                this.$root.toastRes(res);
                const host = this.$root.hostContainers[""];
                if (res.ok && host) {
                    host.containerControl = enabled;
                }
            });
        },

    },
});
</script>

<style lang="scss" scoped>
// Панели раздела стоят колонкой с тем же шагом, что панели файлов
.security {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}
</style>
