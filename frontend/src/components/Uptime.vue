<template>
    <span :class="className" :title="issueText">
        <font-awesome-icon v-if="needsAttention" icon="triangle-exclamation" class="me-1" />{{ statusName }}
    </span>
</template>

<script>
import { ATTENTION, statusColor, statusNameShort } from "../../../common/util-common";

export default {
    props: {
        stack: {
            type: Object,
            default: null,
        },
        fixedWidth: {
            type: Boolean,
            default: false,
        },
    },

    computed: {
        uptime() {
            return this.$t("notAvailableShort");
        },

        color() {
            return statusColor(this.stack?.status);
        },

        statusName() {
            return this.$t(statusNameShort(this.stack?.status));
        },

        needsAttention() {
            return this.stack?.status === ATTENTION;
        },

        /**
         * Tooltip explaining why the stack needs attention
         * @returns {string} Reason list, empty when there is nothing to explain
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

        className() {
            let className = `badge rounded-pill bg-${this.color}`;

            if (this.fixedWidth) {
                className += " fixed-width";
            }
            return className;
        },
    },
};
</script>

<style scoped>
.badge {
    min-width: 62px;
}

.fixed-width {
    /* Wide enough for the attention label with its warning icon */
    width: 86px;
    overflow: hidden;
    text-overflow: ellipsis;
}
</style>
