<template>
    <!-- Полоса внимания: с главной видно, что именно сломалось, без выбора стека -->
    <div v-if="stacks.length > 0" class="attention-strip attention-block" role="status">
        <span class="attention-badge">{{ $t("attentionBadge") }}</span>

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

/** Сколько стеков названо прямо в полосе: остальные - под "Еще N" */
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
// Коробку и метку дает система (`.attention-block`, `.attention-badge`);
// здесь только раскладка: на главной причины стоят в строку
.attention-strip {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    flex-wrap: wrap;
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
    gap: var(--gap-sm);
    min-width: 0;
}

.stack {
    font-weight: var(--weight-strong);
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
}

// На узком экране действие уходит на свою строку, а метка и причины делят
// первую. В три колонки на телефоне причине оставалось десять знаков ширины,
// и она рвалась посреди слова, а имя стека переносилось по дефису
@media (max-width: 800px) {
    .attention-strip {
        align-items: flex-start;
    }

    .reasons {
        flex: 1 1 12ch;
    }

    .reason {
        flex-wrap: wrap;
    }

    .btn {
        flex: 1 0 100%;
        justify-content: center;
    }
}
</style>
