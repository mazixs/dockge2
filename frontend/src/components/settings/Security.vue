<template>
    <!-- Безопасность разложена по панелям: учетная запись, второй фактор и
         отключение входа. Каждая говорит, что именно она меняет -->
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

        <TwoFADialog ref="TwoFADialog" />

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
            }
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
        }
    },

    watch: {
        "password.repeatNewPassword"() {
            this.invalidPassword = false;
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
