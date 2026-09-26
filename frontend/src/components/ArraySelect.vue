<template>
    <div>
        <div v-if="valid">
            <ul v-if="isArrayInited" class="value-list">
                <li v-for="(value, index) in array" :key="index" class="value-row">
                    <select v-model="array[index]" class="value-input">
                        <option value="">{{ $t(`selectNetworkPlaceholder`) }}</option>
                        <option v-for="option in options" :key="option" :value="option">{{ option }}</option>
                    </select>

                    <button class="value-remove" type="button" :aria-label="$t('removeListItem', [ displayName ])" @click="remove(index)">
                        <font-awesome-icon icon="times" />
                    </button>
                </li>
            </ul>

            <button class="btn btn-normal btn-sm add-value" @click="addField">{{ $t("addListItem", [ displayName ]) }}</button>
        </div>
        <div v-else class="form-text">
            {{ $t("longSyntaxNotSupported") }}
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent, type ComponentPublicInstance, type PropType } from "vue";

/**
 * The service the list belongs to, on the service card two components up: a transition
 * sits in between
 * @param field This list
 * @returns The service as the compose file holds it
 */
function editedService(field : ComponentPublicInstance) : Record<string, unknown> {
    const card = field.$parent?.$parent;

    if (!card) {
        throw new Error("A service list is shown outside a service card");
    }

    return (card as ComponentPublicInstance & { service : Record<string, unknown> }).service;
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
        options: {
            type: Array as PropType<string[]>,
            required: true,
        },
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

        service() : Record<string, unknown> {
            return editedService(this);
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
