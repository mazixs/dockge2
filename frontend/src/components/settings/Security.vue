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
                    <label for="current-password" class="form-label">{{ $t("Current Password") }}</label>
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
                    <label for="new-password" class="form-label">{{ $t("New Password") }}</label>
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
                    <label for="repeat-new-password" class="form-label">{{ $t("Repeat New Password") }}</label>
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
                        {{ $t("Update Password") }}
                    </button>
                    <button id="logout-btn" class="btn btn-normal btn-danger-text" type="button" @click="$root.logout">{{ $t("Logout") }}</button>
                </div>
            </form>
        </section>

        <section v-if="!settings.disableAuth" class="panel">
            <div class="panel-bar">
                <h2 class="panel-title"><ShieldCheck />{{ $t("Two Factor Authentication") }}</h2>
            </div>

            <div class="panel-body form-stack">
                <p class="form-text">{{ $t("securityTwoFactorHint") }}</p>
                <div class="actions">
                    <button class="btn btn-normal" type="button" @click="$refs.TwoFADialog.show()">{{ $t("2FA Settings") }}</button>
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
                    <button v-if="settings.disableAuth" id="enableAuth-btn" class="btn btn-normal" @click="enableAuth">{{ $t("Enable Auth") }}</button>
                    <button v-else id="disableAuth-btn" class="btn btn-normal btn-danger-text" @click="confirmDisableAuth">{{ $t("Disable Auth") }}</button>
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
                <p v-if="consoleState?.forced" class="form-text">{{ $t("securityConsoleForced") }}</p>
                <div v-else-if="consoleState" class="actions">
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

        <TwoFADialog ref="TwoFADialog" />

        <Confirm ref="confirmConsole" btn-style="btn-danger" :yes-text="$t(consoleAction === 'operators' ? 'consoleAllowOperators' : 'consoleTurnOn')" :no-text="$t('cancel')" @yes="confirmConsole" @no="consolePassword = ''">
            <p>{{ $t(consoleAction === "operators" ? "consoleAllowOperatorsConfirm" : "consoleTurnOnConfirm") }}</p>

            <div class="field">
                <label for="console-password" class="form-label">{{ $t("Current Password") }}</label>
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

        <Confirm ref="confirmDisableAuth" btn-style="btn-danger" :yes-text="$t('I understand, please disable')" :no-text="$t('Leave')" @yes="disableAuth">
            <i18n-t scope="global" keypath="disableauth.message1" tag="p">
                <template #disableAuth>
                    <strong>{{ $t('disableAuth') }}</strong>
                </template>
            </i18n-t>

            <i18n-t scope="global" keypath="disableauth.message2" tag="p">
                <template #scenarios>
                    <strong>{{ $t('scenarios') }}</strong>
                </template>
            </i18n-t>

            <p>{{ $t("Please use this option carefully!") }}</p>

            <div class="field">
                <label for="current-password2" class="form-label">{{ $t("Current Password") }}</label>
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

<script>
import Confirm from "../../components/Confirm.vue";
import TwoFADialog from "../../components/TwoFADialog.vue";
import InterfaceIcon from "../InterfaceIcon.vue";
import ShieldCheck from "../ShieldCheck.vue";
import { authClient } from "../../auth-client";
import { authErrorMessage, passwordChangeRequest } from "../../auth-messages";

export default {
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
            /** @type {{ enabled: boolean, forced: boolean, operators: boolean } | null} */
            consoleState: null,
            /** What the password dialog confirms: turning the console on, or letting operators in */
            consoleAction: "enable",
            consolePassword: "",
            consoleProcessing: false,
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        consoleStateLabel() {
            if (this.consoleState?.forced) {
                return this.$t("consoleStateForced");
            }
            return this.$t(this.consoleState?.enabled ? "consoleStateOn" : "consoleStateOff");
        },
    },

    watch: {
        "password.repeatNewPassword"() {
            this.invalidPassword = false;
        },
        "$root.isAdmin": {
            immediate: true,
            handler(isAdmin) {
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

                this.$root.toastSuccess("Saved");
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

        /** Show confirmation dialog for disable auth */
        confirmDisableAuth() {
            this.$refs.confirmDisableAuth.show();
        },

        /** Read whether the console of this server is on, what decided it and who may open it */
        async loadConsoleState() {
            const res = await this.$root.emitAgentRequest("", "checkMainTerminal", []);
            this.consoleState = "msg" in res && res.msg ? null : { enabled: res.ok,
                forced: Boolean("forced" in res && res.forced),
                operators: Boolean("operators" in res && res.operators) };
        },

        /**
         * Ask for the password before a change that widens access to the console
         * @param {"enable" | "operators"} action What the dialog confirms
         * @returns {void}
         */
        askConsole(action) {
            this.consoleAction = action;
            this.$refs.confirmConsole.show();
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
         * @param {boolean} enabled Whether the console should be on
         * @returns {void}
         */
        setConsole(enabled) {
            this.consoleProcessing = true;
            this.$root.getSocket().emit("setConsoleEnabled", enabled, enabled ? this.consolePassword : "", (res) => {
                this.consoleProcessing = false;
                this.consolePassword = "";
                this.$root.toastRes(res);
                if (res.ok) {
                    this.consoleState = { ...this.consoleState,
                        enabled };
                }
            });
        },

        /**
         * Let operators open the console, with the password, or limit it to owners again
         * @param {boolean} allowed Whether operators may open it
         * @returns {void}
         */
        setConsoleOperators(allowed) {
            this.consoleProcessing = true;
            this.$root.getSocket().emit("setConsoleOperators", allowed, allowed ? this.consolePassword : "", (res) => {
                this.consoleProcessing = false;
                this.consolePassword = "";
                this.$root.toastRes(res);
                if (res.ok) {
                    this.consoleState = { ...this.consoleState,
                        operators: allowed };
                }
            });
        },

    },
};
</script>

<style lang="scss" scoped>
// Панели раздела стоят колонкой с тем же шагом, что панели файлов
.security {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}
</style>
