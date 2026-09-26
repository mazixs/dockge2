<template>
    <!-- Only reads: the panel is changed by its update above, never from here -->
    <div class="panel-container">
        <h3 class="form-label">{{ $t("panelContainerTitle") }}</h3>

        <p v-if="container === undefined" class="card-state" role="status">{{ $t(failed ? "panelContainerFailed" : "panelContainerLoading") }}</p>
        <p v-else-if="container === null" class="card-state">{{ $t("panelContainerNone") }}</p>

        <template v-else>
            <dl class="facts">
                <dt>{{ $t("panelContainerName") }}</dt>
                <dd class="mono">{{ container.name || shortId }}</dd>
                <dt>{{ $t("panelContainerImage") }}</dt>
                <dd class="mono">{{ known(container.image) }}</dd>
                <dt>{{ $t("panelContainerDigest") }}</dt>
                <dd class="mono">{{ known(container.digest) }}</dd>
                <dt>{{ $t("panelContainerState") }}</dt>
                <dd>{{ state }}</dd>
                <dt>{{ $t("panelContainerHealth") }}</dt>
                <dd>{{ health }}</dd>
                <dt>{{ $t("panelContainerStarted") }}</dt>
                <dd>{{ startedAt }}</dd>
                <dt>{{ $t("panelContainerRestarts") }}</dt>
                <dd>{{ container.restartCount ?? $t("unknown") }}</dd>
                <dt>{{ $t("panelContainerCompose") }}</dt>
                <dd class="mono">{{ container.project ? `${container.project} / ${container.service}` : $t("panelContainerNoCompose") }}</dd>
                <dt>{{ $t("panelContainerMounts") }}</dt>
                <dd>
                    <ul v-if="container.mounts.length > 0" class="mounts">
                        <li v-for="mount in container.mounts" :key="mount.destination" class="mono">
                            {{ mount.source || mount.type }} → {{ mount.destination }}<span v-if="mount.readOnly" class="faint"> · {{ $t("panelContainerReadOnly") }}</span>
                        </li>
                    </ul>
                    <template v-else>{{ $t("unknown") }}</template>
                </dd>
            </dl>

            <p v-if="container.dockerSocket" class="socket-risk">{{ $t("panelContainerSocketRisk") }}</p>
        </template>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import { formatMoment } from "../../format";
import { PANEL_CONTAINER_EVENT, type PanelContainer, type PanelContainerAck } from "../../../../common/types/panel-container";

/** How long the card waits for Docker before it says it could not read the container */
const REQUEST_TIMEOUT_MS = 20_000;

export default defineComponent({
    data() {
        return {
            /** undefined while it is read, null when the panel does not run in a container */
            container: undefined as PanelContainer | null | undefined,
            failed: false,
        };
    },
    computed: {
        shortId() : string {
            return this.container?.id.slice(0, 12) ?? "";
        },
        state() : string {
            const state = this.container?.state ?? "";
            const key = `stabilityContainerState_${state}`;
            return state && this.$te(key) ? this.$t(key) : this.known(state);
        },
        health() : string {
            const health = this.container?.health ?? "";
            const key = `stabilityHealth_${health}`;
            return health && this.$te(key) ? this.$t(key) : this.known(health);
        },
        startedAt() : string {
            return formatMoment(this.container?.startedAt, this.$i18n.locale) || this.$t("unknown");
        },
    },
    mounted() {
        this.$root.getSocket().timeout(REQUEST_TIMEOUT_MS).emit(PANEL_CONTAINER_EVENT, (error : Error | null, ack : PanelContainerAck) => {
            if (!error && ack.ok) {
                this.container = ack.container;
            } else {
                this.failed = true;
            }
        });
    },
    methods: {
        /**
         * A value Docker gave, or the word for one it did not
         * @param value Value from Docker
         * @returns Text to show
         */
        known(value : string) : string {
            return value || this.$t("unknown");
        },
    },
});
</script>

<style lang="scss" scoped>
.panel-container {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    padding-top: var(--gap-md);
    border-top: 1px solid var(--line-hair);
}

.card-state {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-faint);
}

.facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--gap-xs) var(--gap-lg);
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    dt {
        font-weight: var(--weight-regular);
        color: var(--text-muted);
    }

    dd {
        margin: 0;
        color: var(--text-strong);
        overflow-wrap: anywhere;
    }
}

.mono {
    font-family: var(--font-mono);
    font-size: var(--text-code);
}

.mounts {
    margin: 0;
    padding: 0;
    list-style: none;
}

.faint {
    color: var(--text-faint);
}

.socket-risk {
    margin: 0;
    padding: var(--gap-sm) var(--gap-md);
    border-left: 3px solid var(--state-attention);
    background-color: color-mix(in srgb, var(--state-attention) 8%, transparent);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-strong);
}

@media (max-width: 560px) {
    .facts {
        grid-template-columns: minmax(0, 1fr);

        dd {
            margin-bottom: var(--gap-xs);
        }
    }
}
</style>
