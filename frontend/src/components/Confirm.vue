<template>
    <div ref="modal" class="modal fade" tabindex="-1">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h2 id="exampleModalLabel" class="modal-title">
                        {{ title || $t("confirm") }}
                    </h2>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" :aria-label="$t('close')" />
                </div>
                <div class="modal-body">
                    <slot />
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn" :class="btnStyle" data-bs-dismiss="modal" @click="yes">
                        {{ yesText || $t("yes") }}
                    </button>
                    <button type="button" class="btn btn-normal" data-bs-dismiss="modal" @click="no">
                        {{ noText || $t("no") }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script lang="ts">
import Modal from "bootstrap/js/dist/modal";
import { defineComponent, shallowRef } from "vue";
import { ownModal } from "../modal-lifecycle";

export default defineComponent({
    props: {
        /** Style of button */
        btnStyle: {
            type: String,
            default: "btn-primary",
        },
        /** Text of the confirming button, "Yes" when empty */
        yesText: {
            type: String,
            default: "",
        },
        /** Text of the declining button, "No" when empty */
        noText: {
            type: String,
            default: "",
        },
        /** Title of the dialog, "Confirm" when empty */
        title: {
            type: String,
            default: null,
        }
    },
    emits: [ "yes", "no" ],
    data: () => ({
        modal: shallowRef<Modal | null>(null),
        releaseModal: null as (() => void) | null,
    }),
    mounted() {
        const element = this.$refs.modal as HTMLElement;
        this.modal = new Modal(element);
        this.releaseModal = ownModal(element, this.modal);
    },
    beforeUnmount() {
        this.releaseModal?.();
    },
    methods: {
        /**
         * Show the confirm dialog
         * @returns {void}
         */
        show() {
            this.modal?.show();
        },
        /**
         * @fires string "yes" Notify the parent when Yes is pressed
         * @returns {void}
         */
        yes() {
            this.$emit("yes");
        },
        /**
         * @fires string "no" Notify the parent when No is pressed
         * @returns {void}
         */
        no() {
            this.$emit("no");
        }
    },
});
</script>
