<template>
    <div class="shadow-box big-padding mb-3">
        <div class="form-text mb-3">{{ $t("secretsHint") }}</div>

        <!-- Existing secret files -->
        <div v-for="secret in secretFiles" :key="secret.fileName" class="secret mb-3">
            <div class="d-flex align-items-center flex-wrap gap-2">
                <span class="file-name">{{ secret.fileName }}</span>
                <span v-if="secret.secretName" class="badge bg-primary">{{ secret.secretName }}</span>
                <span v-else class="badge bg-secondary">{{ $t("secretNotBound") }}</span>
                <span v-for="service in secret.services" :key="service" class="badge bg-secondary">{{ service }}</span>
                <span class="meta">{{ secret.size }} {{ $t("bytes") }}</span>
            </div>

            <div class="mt-2 d-flex align-items-center gap-2 flex-wrap">
                <!-- The value is masked until it is explicitly revealed -->
                <input
                    :value="revealed[secret.fileName] ?? maskedValue"
                    class="form-control secret-value"
                    :readonly="revealed[secret.fileName] === undefined"
                    :type="revealed[secret.fileName] === undefined ? 'password' : 'text'"
                    @input="revealed[secret.fileName] = $event.target.value"
                />

                <button v-if="revealed[secret.fileName] === undefined" class="btn btn-normal" :disabled="disabled" @click="askPassword('reveal', secret.fileName)">
                    <font-awesome-icon icon="eye" class="me-1" />
                    {{ $t("revealSecret") }}
                </button>
                <template v-else>
                    <button class="btn btn-primary" :disabled="disabled" @click="askPassword('save', secret.fileName)">
                        <font-awesome-icon icon="save" class="me-1" />
                        {{ $t("saveSecret") }}
                    </button>
                    <button class="btn btn-normal" :disabled="disabled" @click="hide(secret.fileName)">
                        <font-awesome-icon icon="eye-slash" class="me-1" />
                        {{ $t("hideSecret") }}
                    </button>
                </template>

                <button class="btn btn-danger" :disabled="disabled" @click="askPassword('delete', secret.fileName)">
                    <font-awesome-icon icon="trash" class="me-1" />
                    {{ $t("deleteSecret") }}
                </button>
            </div>

            <!-- Referencing the secret from the compose file -->
            <div class="mt-2 d-flex align-items-center gap-2 flex-wrap">
                <input
                    v-model="bindName[secret.fileName]"
                    class="form-control secret-name"
                    :placeholder="$t('secretName')"
                    :disabled="disabled"
                />
                <select v-model="bindServices[secret.fileName]" class="form-select secret-services" multiple :disabled="disabled">
                    <option v-for="service in services" :key="service" :value="service">{{ service }}</option>
                </select>
                <button class="btn btn-normal" :disabled="disabled" @click="bind(secret.fileName)">
                    <font-awesome-icon icon="link" class="me-1" />
                    {{ $t("bindSecret") }}
                </button>
                <button v-if="secret.secretName" class="btn btn-normal" :disabled="disabled" @click="unbind(secret.secretName)">
                    <font-awesome-icon icon="unlink" class="me-1" />
                    {{ $t("unbindSecret") }}
                </button>
            </div>
        </div>

        <!-- Create a new secret file -->
        <div class="d-flex align-items-center gap-2 flex-wrap">
            <input v-model="newFileName" class="form-control secret-name" placeholder=".secret.db" :disabled="disabled" />
            <button class="btn btn-normal" :disabled="disabled || !newFileName" @click="askPassword('create', newFileName)">
                <font-awesome-icon icon="plus" class="me-1" />
                {{ $t("addSecret") }}
            </button>
        </div>

        <!-- Reading or changing a secret is a separate authorised action -->
        <BModal v-model="showPasswordDialog" :title="$t('confirmSecretAction')" :okTitle="$t('confirm')" :cancelTitle="$t('cancel')" @ok="runPendingAction" @hidden="resetPassword">
            <p>{{ $t("secretPasswordHint") }}</p>
            <input v-model="currentPassword" type="password" class="form-control" autocomplete="current-password" />
        </BModal>
    </div>
</template>

<script>
export default {
    props: {
        stackName: {
            type: String,
            required: true,
        },
        endpoint: {
            type: String,
            default: "",
        },
        secretFiles: {
            type: Array,
            default: () => [],
        },
        /** Services of the compose file, used for binding */
        services: {
            type: Array,
            default: () => [],
        },
        disabled: {
            type: Boolean,
            default: false,
        },
    },
    emits: [ "updated" ],
    data() {
        return {
            maskedValue: "••••••••",
            revealed: {},
            bindName: {},
            bindServices: {},
            newFileName: "",
            showPasswordDialog: false,
            currentPassword: "",
            pendingAction: null,
            pendingFileName: "",
        };
    },
    watch: {
        secretFiles: {
            immediate: true,
            handler(files) {
                for (const secret of files) {
                    if (this.bindName[secret.fileName] === undefined) {
                        this.bindName[secret.fileName] = secret.secretName;
                    }
                    if (this.bindServices[secret.fileName] === undefined) {
                        this.bindServices[secret.fileName] = [ ...secret.services ];
                    }
                }
            },
        },
    },
    methods: {
        /**
         * Ask for the current password before an action that touches secret content
         * @param {string} action reveal, save, delete or create
         * @param {string} fileName Secret file
         * @returns {void}
         */
        askPassword(action, fileName) {
            this.pendingAction = action;
            this.pendingFileName = fileName;
            this.showPasswordDialog = true;
        },

        resetPassword() {
            this.currentPassword = "";
            this.pendingAction = null;
            this.pendingFileName = "";
        },

        runPendingAction() {
            const action = this.pendingAction;
            const fileName = this.pendingFileName;
            const password = this.currentPassword;

            if (!action || !fileName) {
                return;
            }

            if (action === "reveal") {
                this.$root.emitAgent(this.endpoint, "revealSecret", this.stackName, fileName, password, (res) => {
                    if (res.ok) {
                        this.revealed[fileName] = res.content;
                    } else {
                        this.$root.toastRes(res);
                    }
                });
            } else if (action === "save") {
                this.$root.emitAgent(this.endpoint, "saveSecret", this.stackName, fileName, this.revealed[fileName] ?? "", password, (res) => {
                    this.$root.toastRes(res);
                    if (res.ok) {
                        this.$emit("updated", res.secretFiles);
                    }
                });
            } else if (action === "create") {
                this.$root.emitAgent(this.endpoint, "saveSecret", this.stackName, fileName, "", password, (res) => {
                    this.$root.toastRes(res);
                    if (res.ok) {
                        this.newFileName = "";
                        this.$emit("updated", res.secretFiles);
                    }
                });
            } else if (action === "delete") {
                this.$root.emitAgent(this.endpoint, "deleteSecret", this.stackName, fileName, password, (res) => {
                    this.$root.toastRes(res);
                    if (res.ok) {
                        delete this.revealed[fileName];
                        this.$emit("updated", res.secretFiles);
                    }
                });
            }
        },

        /**
         * Forget a revealed value so the mask comes back
         * @param {string} fileName Secret file
         * @returns {void}
         */
        hide(fileName) {
            delete this.revealed[fileName];
        },

        /**
         * Reference the secret from the compose file
         * @param {string} fileName Secret file
         * @returns {void}
         */
        bind(fileName) {
            const secretName = this.bindName[fileName];
            const services = this.bindServices[fileName] ?? [];

            this.$root.emitAgent(this.endpoint, "bindSecret", this.stackName, secretName, fileName, services, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.$emit("updated", res.secretFiles);
                }
            });
        },

        /**
         * Remove the compose reference of a secret
         * @param {string} secretName Compose secret name
         * @returns {void}
         */
        unbind(secretName) {
            this.$root.emitAgent(this.endpoint, "unbindSecret", this.stackName, secretName, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    this.$emit("updated", res.secretFiles);
                }
            });
        },
    },
};
</script>

<style scoped lang="scss">
@import "../styles/vars";

.secret {
    padding-bottom: 0.75rem;
    border-bottom: 1px solid rgba(127, 127, 127, 0.25);

    &:last-of-type {
        border-bottom: none;
    }
}

.file-name {
    font-family: var(--font-mono);
}

.meta {
    font-size: 0.8rem;
    opacity: 0.7;
}

.secret-value {
    max-width: 320px;
    font-family: var(--font-mono);
}

.secret-name {
    max-width: 220px;
    font-family: var(--font-mono);
}

.secret-services {
    max-width: 220px;
    min-height: 2.4rem;
}
</style>
