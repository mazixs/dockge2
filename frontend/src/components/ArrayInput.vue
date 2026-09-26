<template>
    <div>
        <div v-if="valid">
            <ul v-if="isArrayInited" class="value-list">
                <li v-for="(value, index) in array" :key="index" class="value-row">
                    <input v-model="array[index]" type="text" class="value-input" :placeholder="placeholder" />
                    <button class="value-remove" type="button" :aria-label="$t('removeListItem', [ displayName ])" @click="remove(index)">
                        <font-awesome-icon icon="times" />
                    </button>
                </li>
            </ul>

            <button class="btn btn-normal btn-sm add-value" @click="addField">{{ $t("addListItem", [ displayName ]) }}</button>
        </div>
        <div v-else>
            {{ $t("longSyntaxNotSupported") }}
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent, type ComponentPublicInstance } from "vue";

/** The service card, which holds the list when it edits a service */
interface ServiceCard {
    service : Record<string, unknown>;
}

/** The compose editor, which holds the list when it edits the extension of the panel */
interface ComposeEditor {
    jsonConfig : { "x-dockge"? : Record<string, unknown> };
}

/**
 * The editor that holds the list, two components up: a transition sits in between
 * @param field This list
 * @returns The service card or the compose editor, whichever the list is placed in
 */
function listHost<T>(field : ComponentPublicInstance) : T {
    const host = field.$parent?.$parent;

    if (!host) {
        throw new Error("A list field is shown outside an editor");
    }

    return host as ComponentPublicInstance & T;
}

export default defineComponent({
    props: {
        name: {
            type: String,
            required: true,
        },
        placeholder: {
            type: String,
            default: "",
        },
        displayName: {
            type: String,
            required: true,
        },
        objectType: {
            type: String,
            default: "service",
        }
    },
    data() {
        return {

        };
    },
    computed: {
        array() : unknown[] {
            // Create the array if not exists, it should be safe.
            const value = this.service[this.name];
            return Array.isArray(value) ? value : [];
        },

        /**
         * Check if the array is inited before called v-for.
         * Prevent empty arrays inserted to the YAML file.
         * @return {boolean}
         */
        isArrayInited() : boolean {
            return this.service[this.name] !== undefined;
        },

        /**
         * Not a good name, but it is used to get the object.
         */
        service() : Record<string, unknown> {
            if (this.objectType === "service") {
                // Used in Container.vue
                return listHost<ServiceCard>(this).service;
            } else if (this.objectType === "x-dockge") {
                const extension = listHost<ComposeEditor>(this).jsonConfig["x-dockge"];

                if (!extension) {
                    return {};
                }

                // Used in Compose.vue
                return extension;
            } else {
                return {};
            }
        },

        valid() : boolean {
            // Check if the array is actually an array
            const value = this.service[this.name];
            if (value && !Array.isArray(value)) {
                return false;
            }

            // Check if the array contains non-object only.
            for (let item of this.array) {
                if (typeof item === "object") {
                    return false;
                }
            }
            return true;
        }

    },
    created() {

    },
    methods: {
        addField() {

            // Create the object if not exists.
            if (this.objectType === "x-dockge") {
                const editor = listHost<ComposeEditor>(this);
                if (!editor.jsonConfig["x-dockge"]) {
                    editor.jsonConfig["x-dockge"] = {};
                }
            }

            // Create the array if not exists.
            if (!this.service[this.name]) {
                this.service[this.name] = [];
            }

            this.array.push("");
        },
        remove(index : number) {
            this.array.splice(index, 1);
        },
    }
});
</script>

<style lang="scss" scoped>
// Список и кнопка удаления описаны в main.scss: вид одинаков у портов, сетей
// и переменных, поэтому здесь остается только шаг до кнопки добавления
.add-value {
    margin-top: var(--gap-md);
}
</style>
