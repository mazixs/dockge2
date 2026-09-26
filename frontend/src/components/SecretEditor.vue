<template>
    <!-- Секреты - панель той же анатомии, что выбор файлов над ней. Каждый файл -
         строка списка под тонкой линией, а не карточка в карточке -->
    <section class="panel secrets">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="lock" />{{ $t("secrets") }}</h2>
            <span v-if="secretFiles.length > 0" class="panel-meta">{{ secretFiles.length }}</span>
        </div>

        <!-- Existing secret files -->
        <div v-for="secret in secretFiles" :key="secret.fileName" class="secret">
            <div class="secret-head">
                <span class="file-name">{{ secret.fileName }}</span>
                <!-- Имя секрета из compose и сервисы, которым он выдан: бирки на
                     поверхности панели, привязанное имя окрашено акцентом -->
                <span v-if="secret.secretName" class="tag bound">{{ secret.secretName }}</span>
                <span v-else class="tag">{{ $t("secretNotBound") }}</span>
                <span v-for="service in secret.services" :key="service" class="tag">{{ service }}</span>
                <span class="meta">{{ secret.size }} {{ $t("bytes") }}</span>

                <!-- Удаление стоит в стороне от правки и не кричит: слово красное, кнопка обычная -->
                <button class="btn btn-sm btn-normal btn-danger-text remove" :disabled="disabled" @click="askPassword('delete', secret.fileName)">
                    <font-awesome-icon icon="trash" />{{ $t("deleteSecret") }}
                </button>
            </div>

            <div class="secret-row">
                <!-- The value is masked until it is explicitly revealed -->
                <input
                    :value="revealed[secret.fileName] ?? maskedValue"
                    class="form-control secret-value"
                    :readonly="revealed[secret.fileName] === undefined"
                    :type="revealed[secret.fileName] === undefined ? 'password' : 'text'"
                    :aria-label="secret.fileName"
                    @input="revealed[secret.fileName] = ($event.target as HTMLInputElement).value"
                />

                <button v-if="revealed[secret.fileName] === undefined" class="btn btn-sm btn-normal" :disabled="disabled" @click="askPassword('reveal', secret.fileName)">
                    <font-awesome-icon icon="eye" />{{ $t("revealSecret") }}
                </button>
                <template v-else>
                    <button class="btn btn-sm btn-primary" :disabled="disabled" @click="askPassword('save', secret.fileName)">
                        <font-awesome-icon icon="save" />{{ $t("saveSecret") }}
                    </button>
                    <button class="btn btn-sm btn-normal" :disabled="disabled" @click="hide(secret.fileName)">
                        <font-awesome-icon icon="eye-slash" />{{ $t("hideSecret") }}
                    </button>
                </template>
            </div>

            <!-- Referencing the secret from the compose file -->
            <div class="secret-row">
                <input
                    v-model="bindName[secret.fileName]"
                    class="form-control secret-name"
                    :placeholder="$t('secretName')"
                    :aria-label="$t('secretName')"
                    :disabled="disabled"
                />
                <!-- Сервисы - флажки, а не список с множественным выбором: тот же
                     контрол, что у env-файлов выше, и видно, кто получает секрет -->
                <div class="secret-services" role="group" :aria-labelledby="`secret-services-${secret.fileName}`">
                    <span :id="`secret-services-${secret.fileName}`" class="services-label">{{ $t("bindServices") }}</span>
                    <label v-for="service in services" :key="service" class="form-check form-check-inline">
                        <input v-model="bindServices[secret.fileName]" class="form-check-input" type="checkbox" :value="service" :disabled="disabled" />
                        <span class="form-check-label">{{ service }}</span>
                    </label>
                </div>
                <!-- Привязать и отвязать - пара: при переносе строки они остаются рядом -->
                <div class="secret-actions">
                    <button class="btn btn-sm btn-normal" :disabled="disabled" @click="bind(secret.fileName)">
                        <font-awesome-icon icon="link" />{{ $t("bindSecret") }}
                    </button>
                    <button v-if="secret.secretName" class="btn btn-sm btn-normal" :disabled="disabled" @click="unbind(secret.secretName)">
                        <font-awesome-icon icon="unlink" />{{ $t("unbindSecret") }}
                    </button>
                </div>
            </div>
        </div>

        <!-- Create a new secret file -->
        <div class="panel-body secret-row">
            <input v-model="newFileName" class="form-control secret-name" placeholder=".secret.db" :aria-label="$t('addSecret')" :disabled="disabled" />
            <button class="btn btn-sm btn-normal" :disabled="disabled || !newFileName" @click="askPassword('create', newFileName)">
                <font-awesome-icon icon="plus" />{{ $t("addSecret") }}
            </button>
        </div>

        <p class="panel-foot"><font-awesome-icon icon="info-circle" />{{ $t("secretsHint") }}</p>

        <!-- Reading or changing a secret is a separate authorised action -->
        <BModal v-model="showPasswordDialog" :title="$t('confirmSecretAction')" :okTitle="$t('confirm')" :cancelTitle="$t('cancel')" @ok="runPendingAction" @hidden="resetPassword">
            <p>{{ $t("secretPasswordHint") }}</p>
            <input v-model="currentPassword" type="password" class="form-control" autocomplete="current-password" />
        </BModal>
    </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import type { AgentResponse } from "../../../common/agent-events";
import type { SecretFileMeta } from "../../../common/types/stack";

/** What the password dialog confirms */
type SecretAction = "reveal" | "save" | "delete" | "create";

export default defineComponent({
    components: {
        InterfaceIcon,
    },
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
            type: Array as PropType<SecretFileMeta[]>,
            default: () => [],
        },
        /** Services of the compose file, used for binding */
        services: {
            type: Array as PropType<string[]>,
            default: () => [],
        },
        disabled: {
            type: Boolean,
            default: false,
        },
    },
    emits: [ "updated", "stale" ],
    data() {
        return {
            maskedValue: "••••••••",
            revealed: {} as Record<string, string>,
            bindName: {} as Record<string, string>,
            bindServices: {} as Record<string, string[]>,
            newFileName: "",
            showPasswordDialog: false,
            currentPassword: "",
            pendingAction: null as SecretAction | null,
            pendingFileName: "",
        };
    },
    watch: {
        secretFiles: {
            immediate: true,
            handler(files : SecretFileMeta[]) {
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
         * @param action reveal, save, delete or create
         * @param fileName Secret file
         */
        askPassword(action : SecretAction, fileName : string) {
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
                this.$root.emitAgentRequest(this.endpoint, "revealSecret", [ this.stackName, fileName, password ]).then((res) => {
                    if (res.ok) {
                        this.revealed[fileName] = res.content;
                    } else {
                        this.$root.toastRes(res);
                    }
                });
            } else if (action === "save") {
                this.$root.emitAgentRequest(this.endpoint, "saveSecret", [ this.stackName, fileName, this.revealed[fileName] ?? "", password ]).then((res) => this.settle(res));
            } else if (action === "create") {
                this.$root.emitAgentRequest(this.endpoint, "saveSecret", [ this.stackName, fileName, "", password ]).then((res) => this.settle(res, () => {
                    this.newFileName = "";
                }));
            } else if (action === "delete") {
                this.$root.emitAgentRequest(this.endpoint, "deleteSecret", [ this.stackName, fileName, password ]).then((res) => this.settle(res, () => {
                    delete this.revealed[fileName];
                }));
            }
        },

        /**
         * Report the answer of a secret action and pass the new list up.
         *
         * A lost answer is not a failure: the action may have run on the server, so the
         * list is read again instead of being left as it was.
         * @param res Answer of the server
         * @param done What to tidy up after a success
         */
        settle(res : AgentResponse<{ secretFiles : SecretFileMeta[] }>, done? : () => void) {
            this.$root.toastRes(res);
            if (res.ok) {
                done?.();
                this.$emit("updated", res.secretFiles);
            } else if (res.unknown) {
                this.$emit("stale");
            }
        },

        /**
         * Forget a revealed value so the mask comes back
         * @param fileName Secret file
         */
        hide(fileName : string) {
            delete this.revealed[fileName];
        },

        /**
         * Reference the secret from the compose file
         * @param fileName Secret file
         */
        bind(fileName : string) {
            const secretName = this.bindName[fileName] ?? "";
            const services = this.bindServices[fileName] ?? [];

            this.$root.emitAgentRequest(this.endpoint, "bindSecret", [ this.stackName, secretName, fileName, services ]).then((res) => this.settle(res));
        },

        /**
         * Remove the compose reference of a secret
         * @param secretName Compose secret name
         */
        unbind(secretName : string) {
            this.$root.emitAgentRequest(this.endpoint, "unbindSecret", [ this.stackName, secretName ]).then((res) => this.settle(res));
        },
    },
});
</script>

<style scoped lang="scss">
// Файл секрета - строка списка: отделена линией от следующей, внутри три ряда
// с одним шагом. Строки не вкладываются в панели: панель здесь одна
.secret {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    padding: var(--gap-md);
    border-bottom: 1px solid var(--line-hair);
}

.secret-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-sm);
}

.file-name {
    font-family: var(--font-mono);
    color: var(--text-strong);
}

// Бирка - имя или сервис на поверхности панели; привязанное имя окрашено акцентом
.tag {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--gap-sm);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-chip);
    background-color: var(--surface-raised);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    &.bound {
        border-color: transparent;
        background-color: var(--accent-soft);
        color: var(--accent-text);
    }
}

.meta {
    color: var(--text-faint);
    font-size: var(--text-sm);
}

.remove {
    margin-left: auto;
}

.secret-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-sm);
}

.secret-actions {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    margin-left: auto;
}

.secret-value {
    max-width: 320px;
    font-family: var(--font-mono);
}

.secret-name {
    max-width: 220px;
    font-family: var(--font-mono);
}

// Подпись к флажкам: без нее три имени сервисов в ряду читаются как набор
// бирок, а не как выбор, кому достанется секрет. Подпись занимает свою строку,
// иначе на узком экране первый сервис оказывается ее продолжением
.services-label {
    flex: 1 0 100%;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.secret-services {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-xs) var(--gap-sm);
    min-height: var(--control-height);
    font-size: var(--text-sm);

    .form-check {
        margin: 0;
    }
}
</style>
