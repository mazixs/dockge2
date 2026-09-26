<template>
    <div class="relations">
        <p v-if="error" class="faint" role="alert">{{ error }}</p>
        <p v-else-if="!relations" class="faint" role="status">{{ $t("relationsLoading") }}</p>
        <template v-else>
            <p class="faint">{{ $t(relations.source === "compose" ? "relationsFromCompose" : "relationsFromDocker") }}</p>
            <p v-if="relations.services.length === 0" class="faint">{{ $t("relationsNone") }}</p>
            <section v-for="service in relations.services" :key="`${endpoint}/${stackName}/${service.name}`" class="relation-card" :aria-label="service.name">
                <h3 class="relation-name"><InterfaceIcon name="box" />{{ service.name }}</h3>
                <dl>
                    <template v-if="service.dependsOn.length > 0">
                        <dt>{{ $t("relationsDependsOn") }}</dt>
                        <dd>
                            <span v-for="item in service.dependsOn" :key="item.service" class="relation-item">{{ item.service }} <span class="faint">· {{ conditionLabel(item.condition) }}</span></span>
                        </dd>
                    </template>
                    <dt>{{ $t("containerNetworks") }}</dt>
                    <dd class="mono">{{ service.networks.length > 0 ? service.networks.join(", ") : $t("containerNone") }}</dd>
                    <dt>{{ $t("containerPorts") }}</dt>
                    <dd>
                        <template v-if="service.ports.length > 0">
                            <span v-for="port in service.ports" :key="portLabel(port)" class="relation-item mono">{{ portLabel(port) }}</span>
                        </template>
                        <template v-else>{{ $t("containerNone") }}</template>
                    </dd>
                    <template v-if="service.volumes.length > 0">
                        <dt>{{ $t("panelContainerMounts") }}</dt>
                        <dd>
                            <span v-for="volume in service.volumes" :key="volume.target" class="relation-item mono">{{ volume.source || volume.type }} → {{ volume.target }}<span v-if="volume.readOnly" class="faint"> · {{ $t("panelContainerReadOnly") }}</span></span>
                        </dd>
                    </template>
                    <template v-if="service.secrets.length > 0">
                        <dt>{{ $t("relationsSecrets") }}</dt>
                        <dd class="mono">{{ service.secrets.join(", ") }}</dd>
                    </template>
                    <dt>{{ $t("relationsContainers") }}</dt>
                    <dd>
                        <template v-if="service.containers.length > 0">
                            <router-link v-for="container in service.containers" :key="container.id" :to="containerUrl(container.id)" class="relation-item mono">{{ container.name }}</router-link>
                        </template>
                        <template v-else>{{ $t("relationsNotRunning") }}</template>
                    </dd>
                </dl>
            </section>
        </template>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import type { RelationPort, StackRelations } from "../../../common/types/relations";

/** How the services of a stack are tied together, read only and loaded when opened */
export default defineComponent({
    components: { InterfaceIcon },
    props: {
        stackName: {
            type: String,
            required: true,
        },
        /** Server of the stack, empty for this one */
        endpoint: {
            type: String,
            default: "",
        },
    },
    data() {
        return {
            relations: null as StackRelations | null,
            error: "",
        };
    },
    watch: {
        stackName() {
            this.load();
        },
        endpoint() {
            this.load();
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        async load() : Promise<void> {
            this.relations = null;
            this.error = "";
            const stackName = this.stackName;
            const res = await this.$root.emitAgentRequest(this.endpoint, "stackRelations", [ stackName ], { timeoutMs: 45_000 });
            if (stackName !== this.stackName) {
                return;
            }
            if (res.ok) {
                this.relations = res.relations;
            } else {
                this.error = res.unknown ? this.$t("requestResultUnknown") : this.$root.serverText(res.msg, "relationsUnavailable");
            }
        },

        /**
         * @param condition Condition Compose waits on
         * @returns It in words
         */
        conditionLabel(condition : string) : string {
            const key = `relationsCondition_${condition}`;
            return this.$te(key) ? this.$t(key) : condition;
        },

        /**
         * @param port Port of a service
         * @returns Host side and container side, or only the latter when nothing is published
         */
        portLabel(port : RelationPort) : string {
            const inside = `${port.target}/${port.protocol}`;
            if (!port.published) {
                return `${inside} · ${this.$t("containerPortNotPublished")}`;
            }
            return `${port.hostIp ? `${port.hostIp}:` : ""}${port.published} → ${inside}`;
        },

        /**
         * @param id Container id
         * @returns Address of its page
         */
        containerUrl(id : string) : string {
            return this.endpoint ? `/container/${id}/${this.endpoint}` : `/container/${id}`;
        },
    },
});
</script>

<style lang="scss" scoped>
.relations {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);

    p {
        margin: 0;
    }
}

.relation-card {
    padding: var(--gap-sm);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);

    dl {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        gap: var(--gap-xs) var(--gap-md);
        margin: var(--gap-xs) 0 0;
        font-size: var(--text-sm);
    }

    dt {
        font-weight: var(--weight-regular);
        color: var(--text-muted);
    }

    dd {
        margin: 0;
        overflow-wrap: anywhere;
    }
}

.relation-name {
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
}

.relation-item {
    display: block;
}

.mono {
    font-family: var(--font-mono);
    font-size: var(--text-code);
}

.faint {
    color: var(--text-faint);
}

@media (max-width: 560px) {
    .relation-card dl {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
