<template>
    <div class="page container-page">
        <div class="page-head">
            <div>
                <h1 class="mono">{{ container?.name || shortId }}</h1>
                <p class="page-lede">{{ sourceText }}<template v-if="endpoint"> · {{ serverName }}</template></p>
            </div>
            <StateChip v-if="container" :state="chipState" :label="$t(`stabilityContainerState_${chipState}`)" />
        </div>

        <p v-if="loadError" class="panel panel-body load-state" role="alert">{{ loadError }}</p>
        <p v-else-if="!container" class="panel panel-body load-state" role="status">{{ $t("panelContainerLoading") }}</p>

        <template v-else>
            <section class="panel">
                <div class="panel-bar">
                    <h2 class="panel-title">{{ $t("containerActions") }}</h2>
                </div>
                <div class="panel-body actions-body">
                    <router-link v-if="container.source === 'managed'" :to="stackRoute" class="btn btn-normal">{{ $t("containerOpenStack") }}</router-link>
                    <p v-else-if="container.panel" class="form-text">{{ $t("containerIsPanel") }}</p>
                    <p v-else-if="container.source === 'unknown'" class="form-text">{{ $t("containerSourceUnknownHint") }}</p>
                    <template v-else-if="canControl">
                        <button v-if="!isRunning" class="btn btn-normal" type="button" :disabled="busy" @click="pending = 'start'">{{ $t("containerStart") }}</button>
                        <button v-if="isRunning" class="btn btn-normal" type="button" :disabled="busy" @click="pending = 'restart'">{{ $t("containerRestart") }}</button>
                        <button v-if="isRunning" class="btn btn-normal btn-danger-text" type="button" :disabled="busy" @click="pending = 'stop'">{{ $t("containerStop") }}</button>
                    </template>
                    <p v-else-if="!$root.canManageStacks" class="form-text">{{ $t("containerViewerHint") }}</p>
                    <i18n-t v-else-if="$root.isAdmin && !endpoint" scope="global" keypath="containerControlOffOwner" tag="p" class="form-text">
                        <template #settings>
                            <router-link to="/settings/security">{{ $t("security") }}</router-link>
                        </template>
                    </i18n-t>
                    <p v-else class="form-text">{{ $t("containerControlOff") }}</p>
                </div>
            </section>

            <section class="panel">
                <div class="panel-bar">
                    <h2 class="panel-title">{{ $t("containerDetails") }}</h2>
                    <button class="btn btn-sm btn-normal" type="button" :disabled="loading" @click="load">{{ $t("containerRefresh") }}</button>
                </div>
                <dl class="panel-body facts">
                    <dt>{{ $t("panelContainerImage") }}</dt>
                    <dd class="mono">{{ known(container.image) }}</dd>
                    <template v-if="container.project">
                        <dt>{{ $t("panelContainerCompose") }}</dt>
                        <dd class="mono">{{ container.project }} / {{ container.service }}</dd>
                        <dt>{{ $t("containerWorkingDir") }}</dt>
                        <dd class="mono">{{ known(container.workingDir) }}</dd>
                    </template>
                    <dt>{{ $t("panelContainerState") }}</dt>
                    <dd>{{ dockerState }}</dd>
                    <dt>{{ $t("panelContainerHealth") }}</dt>
                    <dd>{{ health }}</dd>
                    <dt>{{ $t("containerStarted") }}</dt>
                    <dd>{{ moment(container.startedAt) }}</dd>
                    <template v-if="!isRunning">
                        <dt>{{ $t("containerFinished") }}</dt>
                        <dd>{{ moment(container.finishedAt) }}</dd>
                        <dt>{{ $t("containerExitCode") }}</dt>
                        <dd>{{ container.exitCode ?? $t("unknown") }}</dd>
                    </template>
                    <dt>{{ $t("panelContainerRestarts") }}</dt>
                    <dd>{{ container.restartCount ?? $t("unknown") }}</dd>
                    <dt>{{ $t("containerPorts") }}</dt>
                    <dd>
                        <ul v-if="container.ports.length > 0" class="plain-list">
                            <li v-for="port in container.ports" :key="`${port.container}-${port.host}`" class="mono">
                                {{ port.host ? `${port.host} → ${port.container}` : `${port.container} · ${$t("containerPortNotPublished")}` }}
                            </li>
                        </ul>
                        <template v-else>{{ $t("containerNone") }}</template>
                    </dd>
                    <dt>{{ $t("panelContainerMounts") }}</dt>
                    <dd>
                        <ul v-if="container.mounts.length > 0" class="plain-list">
                            <li v-for="mount in container.mounts" :key="mount.destination" class="mono">
                                {{ mount.source || mount.type }} → {{ mount.destination }}<span v-if="mount.readOnly" class="faint"> · {{ $t("panelContainerReadOnly") }}</span>
                            </li>
                        </ul>
                        <template v-else>{{ $t("containerNone") }}</template>
                    </dd>
                    <dt>{{ $t("containerNetworks") }}</dt>
                    <dd class="mono">{{ container.networks.length > 0 ? container.networks.join(", ") : $t("containerNone") }}</dd>
                    <dt>{{ $t("containerId") }}</dt>
                    <dd class="mono">{{ container.id }}</dd>
                </dl>
            </section>
        </template>

        <BModal
            :model-value="pending !== null" :title="pending ? $t(`containerConfirm_${pending}`, [ container?.name ?? shortId ]) : ''"
            :okTitle="pending ? $t(actionLabel[pending]) : ''" :okVariant="pending === 'stop' ? 'danger' : 'primary'" :cancelTitle="$t('cancel')"
            @update:model-value="(open : boolean) => { if (!open) pending = null; }" @ok="run"
        >
            {{ $t("containerConfirmNote") }}
        </BModal>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import StateChip from "../components/StateChip.vue";
import { formatMoment } from "../format";
import { containerStateName } from "../../../common/stability";
import type { ContainerAction, ContainerDetails } from "../../../common/types/container";

/** How long the page waits for Docker on a busy host before it says the result is unknown */
const REQUEST_TIMEOUT_MS = 30_000;

export default defineComponent({
    components: { StateChip },
    data() {
        return {
            container: null as ContainerDetails | null,
            loading: false,
            loadError: "",
            busy: false,
            /** Action waiting for the confirmation dialog */
            pending: null as ContainerAction | null,
            actionLabel: { start: "containerStart",
                stop: "containerStop",
                restart: "containerRestart" } as Record<ContainerAction, string>,
        };
    },
    computed: {
        containerId() : string {
            return String(this.$route.params.containerId ?? "");
        },
        endpoint() : string {
            return String(this.$route.params.endpoint ?? "");
        },
        shortId() : string {
            return this.containerId.slice(0, 12);
        },
        serverName() : string {
            return this.$root.endpointDisplayFunction(this.endpoint) || this.endpoint;
        },
        /** Whether this account may press the buttons: the server decides again on every press */
        canControl() : boolean {
            return this.$root.canManageStacks && this.$root.hostContainers[this.endpoint]?.containerControl === true;
        },
        isRunning() : boolean {
            return this.container?.state === "running";
        },
        chipState() : string {
            return this.container ? containerStateName(this.container) : "unknown";
        },
        dockerState() : string {
            const state = this.container?.state ?? "";
            const key = state === "running" ? "stabilityContainerState_running" : `stabilityDocker_${state}`;
            return this.$te(key) ? this.$t(key) : this.known(state);
        },
        health() : string {
            const health = this.container?.health ?? "";
            const key = `stabilityHealth_${health}`;
            return health && this.$te(key) ? this.$t(key) : this.$t("stabilityNoHealthcheck");
        },
        sourceText() : string {
            switch (this.container?.source) {
                case "managed":
                    return this.$t("containerSourceManaged");
                case "external-compose":
                    return this.$t("containerSourceExternal");
                case "standalone":
                    return this.$t("containerSourceStandalone");
                case "unknown":
                    return this.$t("containerSourceUnknown");
                default:
                    return this.$t("containerTitle");
            }
        },
        /** The stack a managed container belongs to: its directory is the stack's name */
        stackRoute() : string {
            const name = (this.container?.workingDir ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
            return this.endpoint ? `/stack/${name}/${this.endpoint}` : `/stack/${name}`;
        },
    },
    watch: {
        containerId() {
            this.container = null;
            this.load();
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        /** Read the container from Docker; the list never does this for every row */
        async load() : Promise<void> {
            this.loading = true;
            const res = await this.$root.emitAgentRequest(this.endpoint, "inspectContainer", [ this.containerId ], { timeoutMs: REQUEST_TIMEOUT_MS });
            this.loading = false;
            if (res.ok) {
                this.container = res.container;
                this.loadError = "";
            } else {
                this.loadError = res.unknown ? this.$t("requestResultUnknown") : this.$root.serverText(res.msg, "panelContainerFailed");
            }
        },

        /** Run the confirmed action and read the container again, whatever came of it */
        async run() : Promise<void> {
            const action = this.pending;
            this.pending = null;
            if (!action || !this.container) {
                return;
            }
            this.busy = true;
            const res = await this.$root.emitAgentRequest(this.endpoint, "controlContainer", [ this.container.id, action ], { timeoutMs: REQUEST_TIMEOUT_MS });
            this.busy = false;
            if (res.ok) {
                this.$root.toastRes({ ...res,
                    ok: true });
            } else {
                this.$root.toastRes({ ok: false,
                    msg: res.unknown ? "requestResultUnknown" : res.msg || "containerActionFailed",
                    msgi18n: true });
            }
            await this.load();
        },

        /**
         * A moment Docker reported, in the reader's words
         * @param value ISO time from Docker
         * @returns Local date and time, or unknown for year one, which Docker writes for "never"
         */
        moment(value : string) : string {
            return formatMoment(value, this.$i18n.locale) || this.$t("unknown");
        },

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
.page-head h1 {
    overflow-wrap: anywhere;
}

.load-state {
    margin: 0;
    color: var(--text-muted);
}

.actions-body {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-sm);

    .form-text {
        margin: 0;
    }
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
}

dd.mono, li.mono {
    font-size: var(--text-code);
}

.plain-list {
    margin: 0;
    padding: 0;
    list-style: none;
}

.faint {
    color: var(--text-faint);
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
