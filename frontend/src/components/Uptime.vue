<template>
    <StateChip
        :state="state"
        :label="statusName"
        :attention="needsAttention"
        :fixed-width="fixedWidth"
        :title="issueText"
    />
</template>

<script>
import StateChip from "./StateChip.vue";
import { ATTENTION, statusNameShort, statusStateName } from "../../../common/util-common";

export default {
    components: {
        StateChip,
    },
    props: {
        stack: {
            type: Object,
            default: null,
        },
        /** Ровная ширина чипа: в списке имена стеков должны начинаться на одной вертикали */
        fixedWidth: {
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
            return this.$t(statusNameShort(this.stack?.status));
        },

        needsAttention() {
            return this.stack?.status === ATTENTION;
        },

        /**
         * Почему стек требует внимания; подсказка дополняет строку внимания, а не заменяет её
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
