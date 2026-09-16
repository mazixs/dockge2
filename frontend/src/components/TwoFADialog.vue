<template>
    <form @submit.prevent="confirmEnableTwoFA">
        <div ref="modal" class="modal fade" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2 class="modal-title">{{ $t("Setup 2FA") }}</h2>
                        <StateChip
                            v-if="twoFAStatus !== null"
                            class="two-fa-state"
                            :state="twoFAStatus ? 'running' : 'stopped'"
                            :label="$t(twoFAStatus ? 'Active' : 'Inactive')"
                        />
                        <button :disabled="processing" type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close" />
                    </div>

                    <div class="modal-body form-stack">
                        <div v-if="uri && twoFAStatus === false" class="qr">
                            <vue-qrcode :key="uri" :value="uri" type="image/png" :quality="1" :color="{ light: '#ffffffff' }" />
                            <button v-show="!showURI" type="button" class="btn btn-sm btn-normal" @click="showURI = true">{{ $t("Show URI") }}</button>
                            <p v-if="showURI" class="uri">{{ uri }}</p>
                        </div>

                        <div v-if="!(uri && twoFAStatus === false)" class="field">
                            <label for="current-password" class="form-label">{{ $t("Current Password") }}</label>
                            <input
                                id="current-password"
                                v-model="currentPassword"
                                type="password"
                                class="form-control"
                                autocomplete="current-password"
                                :disabled="processing"
                                required
                            />
                        </div>

                        <div v-if="uri === null && twoFAStatus === false" class="actions">
                            <button class="btn btn-primary" type="button" @click="prepare2FA()">{{ $t("Enable 2FA") }}</button>
                        </div>

                        <div v-if="twoFAStatus === true" class="actions">
                            <button class="btn btn-normal btn-danger-text" type="button" :disabled="processing" @click="confirmDisableTwoFA()">{{ $t("Disable 2FA") }}</button>
                        </div>

                        <div v-if="uri && twoFAStatus === false" class="field">
                            <label for="totp-code" class="form-label">{{ $t("twoFAVerifyLabel") }}</label>
                            <input id="totp-code" v-model="token" type="text" maxlength="6" class="form-control" autocomplete="one-time-code" :disabled="processing" required>
                        </div>

                        <!-- Показаны один раз: без приложения это единственный путь назад -->
                        <div v-if="backupCodes.length > 0" class="field">
                            <span class="form-label">{{ $t("backupCodes") }}</span>
                            <pre class="backup-codes">{{ backupCodes.join("\n") }}</pre>
                            <p class="form-text">{{ $t("backupCodesHint") }}</p>
                        </div>
                    </div>

                    <div v-if="uri && twoFAStatus === false" class="modal-footer">
                        <button type="submit" class="btn btn-primary" :disabled="processing || !token">
                            <div v-if="processing" class="spinner-border spinner-border-sm"></div>
                            {{ $t("Save") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </form>

    <Confirm ref="confirmEnableTwoFA" btn-style="btn-primary" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="save2FA">
        {{ $t("confirmEnableTwoFAMsg") }}
    </Confirm>

    <Confirm ref="confirmDisableTwoFA" btn-style="btn-danger" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="disable2FA">
        {{ $t("confirmDisableTwoFAMsg") }}
    </Confirm>
</template>

<script lang="ts">
import { Modal } from "bootstrap";
import Confirm from "./Confirm.vue";
import { authClient } from "../auth-client";
import { authErrorMessage } from "../auth-messages";
import VueQrcode from "vue-qrcode";
import StateChip from "./StateChip.vue";
import { toast } from "vue3-toastify";

export default {
    components: {
        Confirm,
        StateChip,
        VueQrcode,
    },
    props: {},
    data() {
        return {
            currentPassword: "",
            processing: false,
            uri: null,
            twoFAStatus: null,
            token: null,
            showURI: false,
            /** Codes to use when the authenticator is unavailable */
            backupCodes: [],
        };
    },
    mounted() {
        this.modal = new Modal(this.$refs.modal);
        this.getStatus();
    },
    methods: {
        /** Show the dialog */
        show() {
            this.modal.show();
        },

        /** Show dialog to confirm enabling 2FA */
        confirmEnableTwoFA() {
            this.$refs.confirmEnableTwoFA.show();
        },

        /** Show dialog to confirm disabling 2FA */
        confirmDisableTwoFA() {
            this.$refs.confirmDisableTwoFA.show();
        },

        /**
         * Ask the server for a TOTP URI. Enabling two factor needs the password,
         * so a stolen session alone cannot change the second factor.
         * @returns {Promise<void>}
         */
        async prepare2FA() {
            this.processing = true;

            try {
                const { data, error } = await authClient.twoFactor.enable({
                    password: this.currentPassword,
                });

                if (error) {
                    toast.error(authErrorMessage(error));
                    return;
                }

                this.uri = data?.totpURI ?? null;
                this.backupCodes = data?.backupCodes ?? [];
            } finally {
                this.processing = false;
            }
        },

        /**
         * Confirm the setup with a generated code, which is what actually turns it on
         * @returns {Promise<void>}
         */
        async save2FA() {
            this.processing = true;

            try {
                const { error } = await authClient.twoFactor.verifyTotp({
                    code: this.token ?? "",
                });

                if (error) {
                    toast.error(authErrorMessage(error));
                    return;
                }

                // Confirming the code replaces the session, so the socket has to shake
                // hands again with the fresh cookie before it confirms anything else
                await this.$root.reconnectSocket();

                this.$root.toastSuccess("Saved");
                await this.getStatus();
                this.currentPassword = "";
                this.token = null;
                this.uri = null;
                this.backupCodes = [];
                this.modal.hide();
            } finally {
                this.processing = false;
            }
        },

        /**
         * Turn two factor off, again with the password
         * @returns {Promise<void>}
         */
        async disable2FA() {
            this.processing = true;

            try {
                const { error } = await authClient.twoFactor.disable({
                    password: this.currentPassword,
                });

                if (error) {
                    toast.error(authErrorMessage(error));
                    return;
                }

                // Turning it off replaces the session, exactly like turning it on
                await this.$root.reconnectSocket();

                this.$root.toastSuccess("Saved");
                await this.getStatus();
                this.currentPassword = "";
                this.uri = null;
                this.backupCodes = [];
                this.modal.hide();
            } finally {
                this.processing = false;
            }
        },

        /**
         * Whether two factor is enabled for the account of this session
         * @returns {Promise<void>}
         */
        async getStatus() {
            const { data, error } = await authClient.getSession();

            // A failed request must not claim that two factor is off, because the dialog
            // would then offer to enable it on an account that already has it
            if (error || !data?.user) {
                this.twoFAStatus = null;
                return;
            }

            this.twoFAStatus = Boolean((data.user as { twoFactorEnabled? : boolean }).twoFactorEnabled);
        },
    },
};
</script>

<style lang="scss" scoped>
.two-fa-state {
    margin-left: var(--gap-sm);
}

// Код для приложения стоит по центру своего блока и не растягивает окно
.qr {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap-sm);
}

.uri {
    margin: 0;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--text-code);
}

.backup-codes {
    margin: 0;
    padding: var(--gap-sm);
    border-radius: var(--radius-control);
    background-color: var(--surface-sunken);
    font-family: var(--font-mono);
    font-size: var(--text-code);
}

// Текст окна: один токен на обе темы вместо правила под темную
.modal-dialog {
    .form-text, p {
        color: var(--text-muted);
    }
}
</style>
