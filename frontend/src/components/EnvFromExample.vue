<template>
    <div class="env-from-example">
        <button v-for="item in examples" :key="item.file" class="btn btn-primary" type="button" :disabled="busy" @click="create(item.file)">
            {{ $t("gitUiCreateEnvFromExample", { file: item.file, example: item.example }) }}
        </button>
        <p v-if="failure" class="notice failure" role="alert">{{ failure }}</p>
    </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import type { GitEnvExample } from "../../../common/types/stack-git";

/**
 * Offer to start a missing env file from the example the repository carries.
 *
 * The copy still holds the example's placeholder values, so the stack opens on its files tab,
 * where the new file is the active env file, instead of starting.
 */
export default defineComponent({
    props: {
        endpoint: { type: String,
            required: true },
        stackName: { type: String,
            required: true },
        examples: { type: Array as PropType<GitEnvExample[]>,
            required: true },
    },
    data() {
        return {
            busy: false,
            failure: "",
        };
    },
    methods: {
        /**
         * Copy the example and open the stack on the new file
         * @param file Env file to create
         */
        create(file : string) : void {
            this.busy = true;
            this.failure = "";
            this.$root.emitAgentRequest(this.endpoint, "createEnvFromExample", [ this.stackName, file ]).then((res) => {
                this.busy = false;
                if (!res?.ok) {
                    this.failure = this.$root.serverText(res?.msg, "gitUiRequestFailed");
                    return;
                }
                this.$root.toastRes(res);
                this.$router.push(`/stack/${encodeURIComponent(this.stackName)}/files${this.endpoint ? `/${encodeURIComponent(this.endpoint)}` : ""}`);
            });
        },
    },
});
</script>

<style lang="scss" scoped>
.env-from-example {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap-sm);

    p {
        margin: 0;
    }
}
</style>
