<template>
    <!-- Сети стека: свои и внешние. Каждая группа - поле системы с подписью,
         поэтому имена групп звучат так же тихо, как подписи остальных полей -->
    <div class="networks form-stack">
        <fieldset class="field">
            <legend class="form-label">{{ $t("internalNetworks") }}</legend>
            <ul class="value-list">
                <li v-for="(networkRow, index) in networkList" :key="index" class="value-row">
                    <input v-model="networkRow.key" type="text" class="value-input" :placeholder="$t(`networkNamePlaceholder`)" @change="applyToYAML(false)" />
                    <button class="value-remove" type="button" :aria-label="$t('removeListItem', [ $t('internalNetworks') ])" @click="remove(index)">
                        <font-awesome-icon icon="times" />
                    </button>
                </li>
            </ul>
            <button class="btn btn-normal btn-sm add-value" type="button" @click="addField">{{ $t("addInternalNetwork") }}</button>
        </fieldset>

        <fieldset class="field">
            <legend class="form-label">{{ $t("externalNetworks") }}</legend>

            <p v-if="externalNetworkList.length === 0" class="form-text">{{ $t("noExternalNetworks") }}</p>

            <!-- Переключатель сети по контракту системы: button с role="switch",
                 подпись слева, вид сети справа. Чекбокс Bootstrap не давал ни
                 состояния для чтения с экрана, ни цели нажатия нужного размера -->
            <div v-for="networkName in ownExternal" :key="networkName" class="network-row">
                <span class="network-name">{{ networkName }}</span>
                <span class="network-kind">{{ $t("externalNetworkKind") }}</span>
                <button
                    class="switch" type="button" role="switch"
                    :aria-checked="!!selectedExternalList[networkName]"
                    :aria-label="networkName"
                    @click="toggleExternal(networkName)"
                >
                    <span class="knob" aria-hidden="true"></span>
                </button>
            </div>

            <!-- The rest of the machine's networks: offered, but folded when there are
                 many, so the networks of this file are not lost among other stacks' ones -->
            <details v-if="otherExternal.length > 0" class="other-networks" :open="otherExternal.length <= OTHER_SHOWN">
                <summary>{{ $t("otherNetworks", [ otherExternal.length ]) }}</summary>
                <div v-for="networkName in otherExternal" :key="networkName" class="network-row">
                    <span class="network-name">{{ networkName }}</span>
                    <span class="network-kind">{{ $t("externalNetworkKind") }}</span>
                    <button
                        class="switch" type="button" role="switch"
                        :aria-checked="!!selectedExternalList[networkName]"
                        :aria-label="networkName"
                        @click="toggleExternal(networkName)"
                    >
                        <span class="knob" aria-hidden="true"></span>
                    </button>
                </div>
            </details>
        </fieldset>
    </div>
</template>
<script lang="ts">
import { defineComponent, type ComponentPublicInstance } from "vue";
import type { ComposeModel } from "../../../common/compose-editor";

/** How many other networks are listed unfolded */
const OTHER_SHOWN = 3;

/** A network as the compose file declares it */
interface NetworkDefinition {
    external? : boolean;
    [key : string] : unknown;
}

/** A row of the internal networks; a network declared without settings is null */
interface NetworkRow {
    key : string;
    value : NetworkDefinition | null;
}

/** What the network editor uses of the compose page it is rendered in */
interface ComposePageApi {
    jsonConfig : ComposeModel;
    stack : { name : string };
    editorFocus : boolean;
    endpoint : string;
    applyNetworksEdit(networks : Record<string, NetworkDefinition | null>, options? : { explicitRemoval? : boolean }) : void;
}

/**
 * The compose page this editor is rendered in, through the transition of the page
 * @param parent Parent of the editor
 * @returns The page
 */
function composePage(parent : ComponentPublicInstance | null) : ComposePageApi {
    const page = parent?.$parent;
    if (!page || !("applyNetworksEdit" in page)) {
        throw new Error("The network editor is rendered outside the compose page");
    }
    return page as ComponentPublicInstance & ComposePageApi;
}

export default defineComponent({
    data() {
        return {
            OTHER_SHOWN,
            networkList: [] as NetworkRow[],
            externalList: {} as Record<string, NetworkDefinition>,
            selectedExternalList: {} as Record<string, boolean>,
            externalNetworkList: [] as string[],
            /** External networks the file declared when it was read: they stay on top while toggled */
            declaredExternal: [] as string[],
            /** True while the editor is filled from the compose file */
            loading: true,
            /** True when the last change of the model came from this component */
            selfApplied: false,
        };
    },
    computed: {
        jsonConfig() : ComposeModel {
            return composePage(this.$parent).jsonConfig;
        },

        stack() : { name : string } {
            return composePage(this.$parent).stack;
        },

        editorFocus() : boolean {
            return composePage(this.$parent).editorFocus;
        },

        endpoint() : string {
            return composePage(this.$parent).endpoint;
        },

        ownExternal() : string[] {
            return this.externalNetworkList.filter((name) => this.declaredExternal.includes(name));
        },

        otherExternal() : string[] {
            return this.externalNetworkList.filter((name) => !this.declaredExternal.includes(name));
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
         * @param networkName Имя внешней сети
         */
        toggleExternal(networkName : string) {
            this.selectedExternalList[networkName] = !this.selectedExternalList[networkName];
        },

        loadNetworkList() {
            this.loading = true;
            this.networkList = [];
            this.externalList = {};

            for (const [ key, value ] of Object.entries(this.jsonConfig.networks ?? {})) {
                let obj : NetworkRow = {
                    key: key,
                    value: value,
                };

                if (obj.value && obj.value.external) {
                    this.externalList[key] = Object.assign({}, obj.value);
                } else {
                    this.networkList.push(obj);
                }
            }

            this.declaredExternal = Object.keys(this.externalList);

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
            this.$root.emitAgentRequest(this.endpoint, "getDockerNetworkList", []).then((res) => {
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

        remove(index : number) {
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
         * @param explicitRemoval True when the user removed the last network
         */
        applyToYAML(explicitRemoval = false) {
            if (this.editorFocus || this.loading) {
                return;
            }

            const networks : Record<string, NetworkDefinition | null> = {};

            // Internal networks
            for (const networkRow of this.networkList) {
                networks[networkRow.key] = networkRow.value;
            }

            // External networks
            for (const [ networkName, network ] of Object.entries(this.externalList)) {
                networks[networkName] = network;
            }

            this.selfApplied = true;
            composePage(this.$parent).applyNetworksEdit(networks, { explicitRemoval });
        }

    },
});
</script>

<style lang="scss" scoped>
// Группа полей рамки не имеет: подпись группы делает legend, а рамку рисует панель
.networks {
    max-width: none;
}

fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
}

legend {
    float: none;
    width: auto;
    padding: 0;
}

.other-networks {
    margin-top: var(--gap-sm);
}

// The summary keeps its marker: it is the only sign that more is folded here
.other-networks summary {
    padding: var(--gap-xs) 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
}

.other-networks summary:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-offset);
}

.add-value {
    align-self: flex-start;
    margin-top: var(--gap-sm);
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
    position: relative;
    flex: none;
    width: 34px;
    height: 20px;
    padding: 2px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--line-control);
    background-color: var(--surface-sunken);

    // Цель нажатия больше рисунка: переключатель рисуется в 20 px, а под пальцем
    // столько не нажимается. Высоту цели дает общий токен контрола, поэтому на
    // узком экране она растет вместе со всеми остальными
    &::before {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 50%;
        height: var(--control-height);
        transform: translateY(-50%);
    }

    .knob {
        display: block;
        width: 14px;
        height: 14px;
        border-radius: var(--radius-pill);
        background-color: var(--text-faint);
        transition: transform var(--motion-base) var(--motion-ease);
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
</style>
