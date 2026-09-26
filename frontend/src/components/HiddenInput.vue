<template>
    <div class="input-group">
        <input
            ref="input"
            v-model="model"
            :type="visibility"
            class="form-control"
            :placeholder="placeholder"
            :maxlength="maxlength"
            :autocomplete="autocomplete"
            :required="required"
            :readonly="typeof readonly === 'string'"
        >

        <button v-if="visibility === 'password'" class="btn btn-normal" type="button" :aria-label="$t('showPassword')" @click="showInput()">
            <font-awesome-icon icon="eye" />
        </button>
        <button v-else class="btn btn-normal" type="button" :aria-label="$t('hidePassword')" @click="hideInput()">
            <font-awesome-icon icon="eye-slash" />
        </button>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
    props: {
        /** The value of the input */
        modelValue: {
            type: String,
            default: ""
        },
        /** A placeholder to use */
        placeholder: {
            type: String,
            default: ""
        },
        /** Maximum length of the input */
        maxlength: {
            type: Number,
            default: 255
        },
        /** Should the field auto complete */
        autocomplete: {
            type: String,
            default: "new-password",
        },
        /** Is the input required? */
        required: {
            type: Boolean
        },
        /** Should the input be read only? */
        readonly: {
            type: String,
            default: undefined,
        },
    },
    emits: [ "update:modelValue" ],
    data() {
        return {
            visibility: "password",
        };
    },
    computed: {
        model: {
            get() : string {
                return this.modelValue;
            },
            set(value : string) {
                this.$emit("update:modelValue", value);
            }
        }
    },
    methods: {
        /** Show users input in plain text */
        showInput() {
            this.visibility = "text";
        },
        /** Censor users input */
        hideInput() {
            this.visibility = "password";
        },
    }
});
</script>
