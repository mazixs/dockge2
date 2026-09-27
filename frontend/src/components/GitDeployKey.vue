<template>
    <div v-if="!unsupported" class="deploy-key" :aria-busy="busy">
        <template v-if="key">
            <p class="deploy-key-title">{{ $t("gitUiDeployKeyTitle") }}</p>
            <code class="deploy-key-line">{{ key.publicKey }}</code>
            <p class="form-text">{{ $t("gitUiDeployKeyFingerprint", { fingerprint: key.fingerprint }) }}</p>
            <p class="form-text">{{ $t("gitUiDeployKeyAdd") }}</p>
            <div class="deploy-key-actions">
                <button class="btn btn-normal btn-sm" type="button" @click="copy">{{ $t("gitUiCopy") }}</button>
                <a v-if="page" class="btn btn-normal btn-sm" :href="page.url" target="_blank" rel="noopener noreferrer">{{ $t("gitUiDeployKeyOpen", { host: page.host }) }}</a>
            </div>
        </template>
        <template v-else-if="checked">
            <p class="form-text">{{ $t("gitUiDeployKeyIntro") }}</p>
            <div class="deploy-key-actions">
                <button class="btn btn-normal btn-sm" type="button" :disabled="busy" @click="load(true)">{{ busy ? $t("gitUiDeployKeyCreating") : $t("gitUiDeployKeyCreate") }}</button>
            </div>
        </template>
        <p v-if="failure" class="form-text failure-text" role="alert">{{ failure }}</p>
    </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import { deployKeyPage } from "../git-ui";
import type { GitDeployKey, GitDeployKeySource } from "../../../common/types/stack-git";

/**
 * The key the server reads a private repository with over SSH.
 *
 * The panel creates it on request only, and shows the public half with where to add it.
 * An address typed on the New stack page is looked up after a pause in typing, not on
 * every keystroke; the lookup stays on the panel's server and reaches no remote.
 */
export default defineComponent({
    props: {
        endpoint: { type: String,
            required: true },
        source: { type: Object as PropType<GitDeployKeySource>,
            required: true },
        /** The address, when the source names only the stack: it finds the host's page */
        repository: { type: String,
            default: "" },
    },
    data() {
        return {
            key: null as GitDeployKey | null,
            checked: false,
            busy: false,
            failure: "",
            unsupported: false,
            timer: undefined as ReturnType<typeof setTimeout> | undefined,
            version: 0,
        };
    },
    computed: {
        page() {
            const repository = "repository" in this.source ? this.source.repository : this.repository;
            return deployKeyPage(repository.trim());
        },
    },
    watch: {
        source: {
            /** Look the key up again once the address stops changing */
            handler() {
                this.key = null;
                this.checked = false;
                this.failure = "";
                clearTimeout(this.timer);
                this.timer = setTimeout(() => this.load(false), 400);
            },
            deep: true,
        },
    },
    mounted() {
        this.load(false);
    },
    beforeUnmount() {
        clearTimeout(this.timer);
    },
    methods: {
        /**
         * Read the key of the source, or create it
         * @param create Whether a missing key is created
         */
        load(create : boolean) : void {
            const version = ++this.version;
            this.busy = create;
            this.failure = "";
            this.$root.emitAgentRequest(this.endpoint, "gitDeployKey", [ this.source, create ]).then((res) => {
                if (version !== this.version) {
                    return;
                }
                this.busy = false;
                this.checked = true;
                // A stack cloned over HTTP(S) has nothing to add a key to
                this.unsupported = !res?.ok && res?.msg === "gitDeployKeyNeedsSsh" && "stackName" in this.source;
                if (!res?.ok) {
                    this.failure = this.$root.serverText(res?.msg, "gitUiRequestFailed");
                    return;
                }
                this.key = res.key;
            });
        },
        async copy() : Promise<void> {
            try {
                await navigator.clipboard.writeText(this.key?.publicKey ?? "");
                this.$root.toastSuccess("copiedToClipboard");
            } catch {
                this.failure = this.$t("gitUiCopyFailed");
            }
        },
    },
});
</script>

<style lang="scss" scoped>
.deploy-key {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);

    p {
        margin: 0;
    }
}

.deploy-key-title {
    color: var(--text-strong);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
}

.deploy-key-line {
    display: block;
    padding: var(--gap-sm);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-control);
    background-color: var(--surface-sunken);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
    user-select: all;
}

.deploy-key-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-sm);
}

.failure-text {
    color: var(--state-failed);
}
</style>
