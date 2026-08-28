<template>
    <!-- Полоса внимания: с главной видно, что именно сломалось, без выбора стека -->
    <div v-if="stacks.length > 0" class="attention-strip" role="status">
        <span class="badge-word">{{ $t("attentionBadge") }}</span>

        <div class="reasons">
            <span v-for="item in shown" :key="item.name" class="reason">
                <router-link :to="item.url" class="stack">{{ item.name }}</router-link>
                <span class="what">{{ item.reason }}</span>
            </span>
            <span v-if="hidden > 0" class="more">{{ $t("moreIssues", [ hidden ]) }}</span>
        </div>

        <router-link class="btn btn-sm btn-normal" :to="{ path: '/', query: { filter: 'attention' } }">
            {{ $t("showAttention") }}
        </router-link>
    </div>
</template>

<script>
import { ATTENTION } from "../../../common/util-common";

/** Сколько стеков названо прямо в полосе: остальные - под «Ещё N» */
const SHOWN = 3;

export default {
    computed: {
        /** Стеки, требующие внимания: полоса существует только ради них */
        stacks() {
            return Object.values(this.$root.completeStackList)
                .filter((stack) => stack.status === ATTENTION)
                .sort((first, second) => first.name.localeCompare(second.name));
        },

        shown() {
            return this.stacks.slice(0, SHOWN).map((stack) => ({
                name: stack.name,
                url: stack.endpoint ? `/stack/${stack.name}/${stack.endpoint}` : `/stack/${stack.name}`,
                reason: this.reasonOf(stack),
            }));
        },

        hidden() {
            return Math.max(this.stacks.length - SHOWN, 0);
        },
    },
    methods: {
        /**
         * Одна причина словами: из восьми называется та, из-за которой стек не в порядке
         * @param {object} stack Стек из списка
         * @returns {string} Причина или пустая строка
         */
        reasonOf(stack) {
            const issue = (stack.issues ?? [])[0];

            if (!issue) {
                return "";
            }

            const detail = issue.detail ? ` (${issue.detail})` : "";
            return `${issue.service}: ${this.$t(issue.reason)}${detail}`;
        },
    },
};
</script>

<style lang="scss" scoped>
.attention-strip {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    flex-wrap: wrap;
    padding: var(--gap-sm) var(--gap-md);
    margin-bottom: var(--gap-md);
    border: 1px solid color-mix(in srgb, var(--state-attention) 45%, transparent);
    background-color: color-mix(in srgb, var(--state-attention) 8%, transparent);
    border-radius: var(--radius-panel);
    font-size: var(--text-sm);
}

.badge-word {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--state-attention);
    border: 1px solid color-mix(in srgb, var(--state-attention) 45%, transparent);
    border-radius: var(--radius-chip);
    padding: 1px 6px;
    white-space: nowrap;
}

.reasons {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
    color: var(--text-strong);
}

.reason {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
}

.stack {
    font-weight: 600;
    text-decoration: none;

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

.what {
    color: var(--text-muted);
    overflow-wrap: anywhere;
}

.more {
    color: var(--text-faint);
    font-size: var(--text-xs);
}
</style>
