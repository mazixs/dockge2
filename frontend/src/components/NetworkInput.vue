<template>
    <div>
        <h5>{{ $t("Internal Networks") }}</h5>
        <ul class="list-group">
            <li v-for="(networkRow, index) in networkList" :key="index" class="list-group-item">
                <input v-model="networkRow.key" type="text" class="no-bg domain-input" :placeholder="$t(`Network name...`)" @change="applyToYAML(false)" />
                <font-awesome-icon icon="times" class="action remove ms-2 me-3 text-danger" @click="remove(index)" />
            </li>
        </ul>

        <button class="btn btn-normal btn-sm mt-3 me-2" @click="addField">{{ $t("addInternalNetwork") }}</button>

        <h5 class="mt-3">{{ $t("External Networks") }}</h5>

        <div v-if="externalNetworkList.length === 0">
            {{ $t("No External Networks") }}
        </div>

        <!-- Переключатель сети по контракту системы: button с role="switch",
             подпись слева, вид сети справа. Чекбокс Bootstrap не давал ни
             состояния для чтения с экрана, ни цели нажатия нужного размера -->
        <div v-for="networkName in externalNetworkList" :key="networkName" class="network-row">
            <span class="network-name">{{ networkName }}</span>
            <span class="network-kind">{{ $t("externalNetworkKind") }}</span>
            <button
                class="switch" type="button" role="switch"
                :aria-checked="String(!!selectedExternalList[networkName])"
                :aria-label="networkName"
                @click="toggleExternal(networkName)"
            >
                <span class="knob" aria-hidden="true"></span>
            </button>
        </div>

        <div v-if="false" class="input-group mb-3">
            <input
                placeholder="New external network name..."
                class="form-control"
                @keyup.enter="createExternelNetwork"
            />
            <button class="btn btn-normal btn-sm  me-2" type="button">
                {{ $t("createExternalNetwork") }}
            </button>
        </div>

        <div v-if="false">
            <button class="btn btn-primary btn-sm mt-3 me-2" @click="applyToYAML">{{ $t("applyToYAML") }}</button>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            networkList: [],
            externalList: {},
            selectedExternalList: {},
            externalNetworkList: [],
            /** True while the editor is filled from the compose file */
            loading: true,
            /** True when the last change of the model came from this component */
            selfApplied: false,
        };
    },
    computed: {
        jsonConfig() {
            return this.$parent.$parent.jsonConfig;
        },

        stack() {
            return this.$parent.$parent.stack;
        },

        editorFocus() {
            return this.$parent.$parent.editorFocus;
        },

        endpoint() {
            return this.$parent.$parent.endpoint;
        },
    },
    watch: {
        "jsonConfig.networks": {
            handler() {
                // Reload unless this component caused the change itself, otherwise a stale
                // list would overwrite networks that came from the server or the text editor
                if (!this.selfApplied) {
                    this.loadNetworkList();
                }

                this.selfApplied = false;
            },
            deep: true,
        },

        "selectedExternalList": {
            handler() {
                for (const networkName in this.selectedExternalList) {
                    const enable = this.selectedExternalList[networkName];

                    if (enable) {
                        if (!this.externalList[networkName]) {
                            this.externalList[networkName] = {};
                        }
                        this.externalList[networkName].external = true;
                    } else {
                        delete this.externalList[networkName];
                    }
                }

                // Filling the switches from the compose file is not a user action
                this.applyToYAML();
            },
            deep: true,
        },
    },
    mounted() {
        this.loadNetworkList();
        this.loadExternalNetworkList();
    },
    methods: {
        /**
         * Включить или выключить внешнюю сеть.
         * Watcher на selectedExternalList дописывает сервис в compose, поэтому
         * здесь меняется только состояние.
         * @param {string} networkName Имя внешней сети
         * @returns {void}
         */
        toggleExternal(networkName) {
            this.selectedExternalList[networkName] = !this.selectedExternalList[networkName];
        },

        loadNetworkList() {
            this.loading = true;
            this.networkList = [];
            this.externalList = {};

            for (const key in this.jsonConfig.networks) {
                let obj = {
                    key: key,
                    value: this.jsonConfig.networks[key],
                };

                if (obj.value && obj.value.external) {
                    this.externalList[key] = Object.assign({}, obj.value);
                } else {
                    this.networkList.push(obj);
                }
            }

            // Restore selectedExternalList
            this.selectedExternalList = {};
            for (const networkName in this.externalList) {
                this.selectedExternalList[networkName] = true;
            }

            this.$nextTick(() => {
                this.loading = false;
            });
        },

        loadExternalNetworkList() {
            this.$root.emitAgent(this.endpoint, "getDockerNetworkList", (res) => {
                if (res.ok) {
                    this.externalNetworkList = res.dockerNetworkList.filter((n) => {
                        // Filter out this stack networks
                        if (n.startsWith(this.stack.name + "_")) {
                            return false;
                        }
                        // They should be not supported.
                        // https://docs.docker.com/compose/compose-file/06-networks/#host-or-none
                        if (n === "none" || n === "host" || n === "bridge") {
                            return false;
                        }
                        return true;
                    });
                } else {
                    this.$root.toastRes(res);
                }
            });
        },

        addField() {
            this.networkList.push({
                key: "",
                value: {},
            });
        },

        remove(index) {
            const removed = this.networkList[index];
            this.networkList.splice(index, 1);

            // Only removing a network that really existed counts as the explicit action that
            // takes the `networks` key out of the file
            const removedRealNetwork = (removed?.key ?? "").trim() !== "";
            const nothingLeft = this.networkList.length === 0 && Object.keys(this.externalList).length === 0;

            this.applyToYAML(removedRealNetwork && nothingLeft);
        },

        /**
         * Hand the configured networks to the page, which decides how to write them.
         * Nothing happens while the editor is still being filled from the file.
         * @param {boolean} explicitRemoval True when the user removed the last network
         * @returns {void}
         */
        applyToYAML(explicitRemoval = false) {
            if (this.editorFocus || this.loading) {
                return;
            }

            const networks = {};

            // Internal networks
            for (const networkRow of this.networkList) {
                networks[networkRow.key] = networkRow.value;
            }

            // External networks
            for (const networkName in this.externalList) {
                networks[networkName] = this.externalList[networkName];
            }

            this.selfApplied = true;
            this.$parent.$parent.applyNetworksEdit(networks, { explicitRemoval });
        }

    },
};
</script>

<style lang="scss" scoped>
@use "../styles/vars.scss" as *;

.list-group {
    background-color: var(--surface-panel);

    li {
        display: flex;
        align-items: center;
        padding: 10px 0 10px 10px;

        .domain-input {
            flex-grow: 1;
            background-color: transparent;
            border: none;
            color: var(--text-strong);
            outline: none;

            &::placeholder {
                color: var(--text-faint);
            }
        }
    }
}

// Переключатель: 34x20, подпись слева, состояние читается и без цвета
.network-row {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    min-height: var(--control-height);
}

.network-name {
    color: var(--text-strong);
}

.network-kind {
    margin-right: auto;
    font-size: var(--text-sm);
    color: var(--text-faint);
}

.switch {
    flex: none;
    width: 34px;
    height: 20px;
    padding: 2px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--line-control);
    background-color: var(--surface-sunken);

    .knob {
        display: block;
        width: 14px;
        height: 14px;
        border-radius: var(--radius-pill);
        background-color: var(--text-faint);
        transition: transform ease-in-out 0.12s;
    }

    &[aria-checked="true"] {
        background-color: var(--accent);
        border-color: var(--accent);

        .knob {
            background-color: var(--text-on-accent);
            transform: translateX(14px);
        }
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.delete {
    text-decoration: underline;
    font-size: 13px;
    cursor: pointer;
}
</style>
