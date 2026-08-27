<template>
    <form @submit.prevent="confirmEnableTwoFA">
        <div ref="modal" class="modal fade" tabindex="-1" data-bs-backdrop="static">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">
                            {{ $t("Setup 2FA") }}
                            <span v-if="twoFAStatus == true" class="badge bg-primary">{{ $t("Active") }}</span>
                            <span v-if="twoFAStatus == false" class="badge bg-primary">{{ $t("Inactive") }}</span>
                        </h5>
                        <button :disabled="processing" type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close" />
                    </div>
                    <div class="modal-body">
                        <div class="mb-3">
                            <div v-if="uri && twoFAStatus == false" class="mx-auto text-center" style="width: 210px;">
                                <vue-qrcode :key="uri" :value="uri" type="image/png" :quality="1" :color="{ light: '#ffffffff' }" />
                                <button v-show="!showURI" type="button" class="btn btn-outline-primary btn-sm mt-2" @click="showURI = true">{{ $t("Show URI") }}</button>
                            </div>
                            <p v-if="showURI && twoFAStatus == false" class="text-break mt-2">{{ uri }}</p>

                            <div v-if="!(uri && twoFAStatus == false)" class="mb-3">
                                <label for="current-password" class="form-label">
                                    {{ $t("Current Password") }}
                                </label>
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

                            <button v-if="uri == null && twoFAStatus == false" class="btn btn-primary" type="button" @click="prepare2FA()">
                                {{ $t("Enable 2FA") }}
                            </button>

                            <button v-if="twoFAStatus == true" class="btn btn-danger" type="button" :disabled="processing" @click="confirmDisableTwoFA()">
                                {{ $t("Disable 2FA") }}
                            </button>

                            <div v-if="uri && twoFAStatus == false" class="mt-3">
                                <label for="totp-code" class="form-label">{{ $t("twoFAVerifyLabel") }}</label>
                                <input id="totp-code" v-model="token" type="text" maxlength="6" class="form-control" autocomplete="one-time-code" :disabled="processing" required>
                            </div>

                            <!-- Shown once: these are the only way back in without the authenticator -->
                            <div v-if="backupCodes.length > 0" class="mt-3">
                                <label class="form-label">{{ $t("backupCodes") }}</label>
                                <p class="form-text">{{ $t("backupCodesHint") }}</p>
                                <pre class="backup-codes">{{ backupCodes.join("\n") }}</pre>
                            </div>
                        </div>
                    </div>

                    <div v-if="uri && twoFAStatus == false" class="modal-footer">
                        <button type="submit" class="btn btn-primary" :disabled="processing || !token">
                            <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                            {{ $t("Save") }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </form>

    <Confirm ref="confirmEnableTwoFA" btn-style="btn-danger" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="save2FA">
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
import { toast } from "vue3-toastify";

export default {
    components: {
        Confirm,
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
@use "../styles/vars.scss" as *;

.backup-codes {
    padding: 0.5rem;
    border-radius: 0.5rem;
    background-color: rgba(127, 127, 127, 0.15);
    font-family: var(--font-mono);
}

.dark {
    .modal-dialog .form-text, .modal-dialog p {
        color: $dark-font-color;
    }
}
</style>
