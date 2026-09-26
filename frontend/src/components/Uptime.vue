<template>
    <StateChip
        :state="state"
        :label="statusName"
        :attention="needsAttention"
        :fixed-width="fixedWidth"
        :compact="compact"
        :dot-only="dotOnly"
        :title="issueText"
    />
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import StateChip from "./StateChip.vue";
import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING, isStackFailed, statusStateName } from "../../../common/util-common";
import type { StackSummaryDTO, ViewerStackSummary } from "../../../common/types/stack";

export default defineComponent({
    components: {
        StateChip,
    },
    props: {
        /** Стек строки: из него читаются состояние и замечания */
        stack: {
            type: Object as PropType<StackSummaryDTO | ViewerStackSummary | null>,
            default: null,
        },
        /** Ровная ширина чипа: в списке имена стеков должны начинаться на одной вертикали */
        fixedWidth: {
            type: Boolean,
            default: false,
        },
        /** Тихий вид для строки списка */
        compact: {
            type: Boolean,
            default: false,
        },
        /** Только точка: слово уходит в скрытый текст */
        dotOnly: {
            type: Boolean,
            default: false,
        },
        /**
         * Оставлен для вызовов, где пилюля запрашивается явно.
         * Чип состояния всегда пилюля, поэтому на вид не влияет.
         */
        pill: {
            type: Boolean,
            default: false,
        },
    },

    computed: {
        /** Имя состояния системы: running, attention, stopped, failed, unknown */
        state() : string {
            return this.stack ? statusStateName(this.stack.status, this.stack.issues) : "unknown";
        },

        statusName() : string {
            const status = this.stack?.status;

            // EXITED is both a stop and a crash: only the exit codes tell them apart
            if (status === EXITED) {
                return this.$t(isStackFailed(status, this.stack?.issues) ? "pagesFailed" : "pagesStopped");
            }

            const labels : Record<number, string> = { [CREATED_FILE]: "pagesNotDeployed",
                [CREATED_STACK]: "pagesStopped",
                [RUNNING]: "pagesRunning",
                [ATTENTION]: "pagesAttention" };
            return this.$t((status !== undefined && labels[status]) || "pagesUnknown");
        },

        needsAttention() : boolean {
            return this.stack?.status === ATTENTION;
        },

        /**
         * Почему стек требует внимания; подсказка дополняет строку внимания, а не заменяет ее
         * @returns {string} Список причин, пустой если объяснять нечего
         */
        issueText() : string {
            const issues = this.stack?.issues;
            if (!Array.isArray(issues) || issues.length === 0) {
                return "";
            }

            return issues
                .map(issue => {
                    const reason = this.$t(issue.reason);
                    const detail = issue.detail ? ` (${issue.detail})` : "";
                    return `${issue.service}: ${reason}${detail}`;
                })
                .join("\n");
        },
    },
});
</script>
