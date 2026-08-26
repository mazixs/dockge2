<template>
    <div class="shadow-box big-padding mb-3">
        <div v-if="inventory.needsComposeSelection" class="alert alert-warning" role="alert">
            <font-awesome-icon icon="triangle-exclamation" class="me-1" />
            {{ $t("needsComposeSelection") }}
        </div>

        <!-- Compose file used for every docker compose call -->
        <div class="mb-3">
            <label class="form-label" for="compose-file-select">{{ $t("composeFile") }}</label>
            <select id="compose-file-select" v-model="config.composeFileName" class="form-select" :disabled="disabled">
                <option v-for="fileName in inventory.composeFileNames" :key="fileName" :value="fileName">
                    {{ fileName }}
                </option>
            </select>
            <div class="form-text">{{ $t("composeFileHint") }}</div>
        </div>

        <!-- Ordered env files passed to compose for interpolation -->
        <div class="mb-3">
            <label class="form-label">{{ $t("envFiles") }}</label>
            <div v-if="inventory.envFileNames.length === 0" class="form-text">{{ $t("noEnvFiles") }}</div>

            <ul v-else class="file-list">
                <li v-for="fileName in orderedEnvFileNames" :key="fileName" class="file-row">
                    <div class="form-check">
                        <input
                            :id="`env-file-${fileName}`"
                            class="form-check-input"
                            type="checkbox"
                            :checked="config.envFileNames.includes(fileName)"
                            :disabled="disabled"
                            @change="toggleEnvFile(fileName)"
                        />
                        <label class="form-check-label" :for="`env-file-${fileName}`">{{ fileName }}</label>
                    </div>

                    <div v-if="config.envFileNames.includes(fileName)" class="btn-group btn-group-sm">
                        <button
                            class="btn btn-normal"
                            :disabled="disabled || envIndex(fileName) === 0"
                            :title="$t('moveUp')"
                            @click="moveEnvFile(fileName, -1)"
                        >
                            <font-awesome-icon icon="chevron-up" />
                        </button>
                        <button
                            class="btn btn-normal"
                            :disabled="disabled || envIndex(fileName) === config.envFileNames.length - 1"
                            :title="$t('moveDown')"
                            @click="moveEnvFile(fileName, 1)"
                        >
                            <font-awesome-icon icon="chevron-down" />
                        </button>
                    </div>
                </li>
            </ul>
            <div class="form-text">{{ $t("envFilesHint") }}</div>
        </div>

        <!-- Env file shown in the editor -->
        <div v-if="inventory.envFileNames.length > 0" class="mb-3">
            <label class="form-label" for="active-env-select">{{ $t("activeEnvFile") }}</label>
            <select id="active-env-select" v-model="config.activeEnvFileName" class="form-select" :disabled="disabled">
                <option value="">{{ $t("none") }}</option>
                <option v-for="fileName in inventory.envFileNames" :key="fileName" :value="fileName">
                    {{ fileName }}
                </option>
            </select>
            <div class="form-text">{{ $t("activeEnvFileHint") }}</div>
        </div>

        <button class="btn btn-primary" :disabled="disabled || !changed" @click="save">
            <font-awesome-icon icon="save" class="me-1" />
            {{ $t("saveFileSelection") }}
        </button>
    </div>
</template>

<script>
export default {
    props: {
        /** Inventory returned by the getStackFiles event */
        inventory: {
            type: Object,
            required: true,
        },
        disabled: {
            type: Boolean,
            default: false,
        },
    },
    emits: [ "save" ],
    data() {
        return {
            config: this.cloneConfig(this.inventory.config),
        };
    },
    computed: {
        /** Selected files first, in their configured order, then the remaining ones */
        orderedEnvFileNames() {
            const selected = this.config.envFileNames.filter(name => this.inventory.envFileNames.includes(name));
            const rest = this.inventory.envFileNames.filter(name => !selected.includes(name));
            return [ ...selected, ...rest ];
        },

        changed() {
            return JSON.stringify(this.config) !== JSON.stringify(this.cloneConfig(this.inventory.config));
        },
    },
    watch: {
        inventory: {
            deep: true,
            handler() {
                this.config = this.cloneConfig(this.inventory.config);
            },
        },
    },
    methods: {
        /**
         * Copy a config so editing does not mutate the inventory
         * @param {object} config Config to copy
         * @returns {object} Copy
         */
        cloneConfig(config) {
            return {
                composeFileName: config.composeFileName,
                envFileNames: [ ...config.envFileNames ],
                activeEnvFileName: config.activeEnvFileName,
                secretBindings: config.secretBindings.map(binding => ({
                    name: binding.name,
                    fileName: binding.fileName,
                    services: [ ...binding.services ],
                })),
            };
        },

        /**
         * Position of an env file in the interpolation order
         * @param {string} fileName Env file
         * @returns {number} Index, -1 when the file is not selected
         */
        envIndex(fileName) {
            return this.config.envFileNames.indexOf(fileName);
        },

        /**
         * Add or remove an env file from the interpolation set
         * @param {string} fileName Env file
         * @returns {void}
         */
        toggleEnvFile(fileName) {
            const index = this.envIndex(fileName);

            if (index === -1) {
                this.config.envFileNames.push(fileName);
            } else {
                this.config.envFileNames.splice(index, 1);

                if (this.config.activeEnvFileName === fileName) {
                    this.config.activeEnvFileName = this.config.envFileNames[0] ?? "";
                }
            }
        },

        /**
         * Move an env file in the interpolation order
         * @param {string} fileName Env file
         * @param {number} offset -1 to move up, 1 to move down
         * @returns {void}
         */
        moveEnvFile(fileName, offset) {
            const index = this.envIndex(fileName);
            const target = index + offset;

            if (index === -1 || target < 0 || target >= this.config.envFileNames.length) {
                return;
            }

            const [ moved ] = this.config.envFileNames.splice(index, 1);
            this.config.envFileNames.splice(target, 0, moved);
        },

        save() {
            this.$emit("save", this.cloneConfig(this.config));
        },
    },
};
</script>

<style scoped lang="scss">
.file-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.25rem;
}

.file-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.15rem 0;
}
</style>
