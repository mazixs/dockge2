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

<script>
import StateChip from "./StateChip.vue";
import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING, statusStateName } from "../../../common/util-common";

export default {
    components: {
        StateChip,
    },
    props: {
        /** Стек строки: из него читаются состояние и замечания */
        stack: {
            /** @type {import("vue").PropType<import("../../../common/types/stack").StackSummaryDTO | import("../../../common/types/stack").ViewerStackSummary | null>} */
            type: Object,
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
        state() {
            return statusStateName(this.stack?.status);
        },

        statusName() {
            const labels = { [CREATED_FILE]: "pagesNotDeployed",
                [CREATED_STACK]: "pagesStopped",
                [RUNNING]: "pagesRunning",
                [EXITED]: "pagesFailed",
                [ATTENTION]: "pagesAttention" };
            return this.$t(labels[this.stack?.status] || "pagesUnknown");
        },

        needsAttention() {
            return this.stack?.status === ATTENTION;
        },

        /**
         * Почему стек требует внимания; подсказка дополняет строку внимания, а не заменяет ее
         * @returns {string} Список причин, пустой если объяснять нечего
         */
        issueText() {
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
};
</script>
