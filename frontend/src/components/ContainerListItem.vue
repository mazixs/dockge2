<template>
    <router-link
        :to="url"
        class="item dim"
        :class="{ active: isCurrent }"
        :aria-current="isCurrent ? 'page' : undefined"
    >
        <span class="stack-letter" aria-hidden="true"><InterfaceIcon name="box" /></span>
        <div class="stack-item-text">
            <span v-ellipsis-title class="name">{{ container.name }}</span>
            <div class="meta">
                <StateChip :state="state" :label="$t(`stabilityContainerState_${state}`)" :compact="true" />
                <span v-ellipsis-title class="image">{{ container.image }}</span>
            </div>
            <div v-if="container.state === 'unknown'" class="seen">{{ lastSeen }}</div>
        </div>
    </router-link>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import StateChip from "./StateChip.vue";
import { formatDuration } from "../format";
import { listQuery } from "../stack-list-model";
import { containerStateName } from "../../../common/stability";
import type { StandaloneContainer } from "../../../common/types/container";

/** A container outside every compose project, as a row of the list */
export default defineComponent({
    components: { InterfaceIcon,
        StateChip },
    props: {
        container: {
            type: Object as PropType<StandaloneContainer>,
            required: true,
        },
        /** Server of the container, empty for this one */
        endpoint: {
            type: String,
            default: "",
        },
    },
    computed: {
        url() : { path : string; query : Record<string, string> } {
            const path = `/container/${this.container.id}`;
            return { path: this.endpoint ? `${path}/${this.endpoint}` : path,
                query: listQuery(this.$route.query) };
        },
        state() : string {
            return containerStateName(this.container);
        },
        isCurrent() : boolean {
            return this.$route.params.containerId === this.container.id && (this.$route.params.endpoint || "") === this.endpoint;
        },
        /** Docker could not be read: say how old the last reading is rather than repeat it */
        lastSeen() : string {
            return this.$t("containerLastSeen", [ formatDuration(Date.now() - this.container.lastSeen, this.$t) ]);
        },
    },
});
</script>

<style lang="scss" scoped>
.stack-letter { display: grid; place-items: center; width: var(--gap-2xl); height: var(--gap-2xl); flex-shrink: 0; border-radius: var(--radius-card); background: var(--surface-sunken); box-shadow: inset 0 0 0 1px var(--line-hair); color: var(--text-muted); font-size: var(--icon-sm); }
.stack-item-text { min-width: 0; flex: 1; }

a.item {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: var(--gap-sm);
    border-radius: var(--radius-panel);
    margin-bottom: var(--gap-xs);
    border: 1px solid transparent;
    text-decoration: none;
    color: var(--text-muted);

    &:hover {
        background-color: var(--surface-raised);
    }

    &.active, &[aria-current] {
        background-color: var(--accent-soft);
        border-color: var(--line-hair);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: calc(var(--focus-offset) * -1);
    }
}

.item:focus-visible .name { white-space: normal; overflow-wrap: anywhere; }

.name {
    display: block;
    font-weight: var(--weight-medium);
    font-size: var(--text-sm);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.meta {
    display: flex;
    align-items: center;
    gap: var(--gap-xs);
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text-faint);
}

.image {
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-code);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.seen {
    font-size: var(--text-sm);
    color: var(--text-faint);
}
</style>
