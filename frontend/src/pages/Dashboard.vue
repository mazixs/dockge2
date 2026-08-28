<template>
    <div class="dashboard-wrap">
        <!-- Полоса внимания стоит над обеими колонками: она про всё хозяйство -->
        <AttentionStrip v-if="!fullWidth" />

        <div class="dashboard" :class="{ full: fullWidth }">
            <!-- Список широкий, инспектор узкий: в строке списка четыре колонки данных,
                 а инспектор держит действия и три коротких секции -->
            <div v-if="!$root.isMobile && !fullWidth" class="list-column">
                <StackList :scrollbar="true" />
            </div>

            <div ref="container" class="work-column">
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" :calculatedHeight="height" />
            </div>
        </div>
    </div>
</template>

<script>

import AttentionStrip from "../components/AttentionStrip.vue";
import StackList from "../components/StackList.vue";

export default {
    components: {
        AttentionStrip,
        StackList,
    },
    data() {
        return {
            height: 0
        };
    },
    computed: {
        /**
         * Редактор compose и терминал занимают экран целиком: список стеков рядом
         * с ними не нужен, а ширина нужна файлу и выводу
         * @returns {boolean} Скрывать ли список
         */
        fullWidth() {
            return this.$route.path.startsWith("/compose") || this.$route.path.startsWith("/terminal");
        },
    },
    mounted() {
        this.height = this.$refs.container.offsetHeight;
    },
};
</script>

<style lang="scss" scoped>
.dashboard-wrap {
    width: 98%;
    margin: 0 auto;
}

.dashboard {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 400px;
    gap: var(--gap-lg);
    padding-bottom: var(--gap-lg);

    // Редактор и терминал забирают экран целиком
    &.full {
        grid-template-columns: minmax(0, 1fr);
    }
}

.list-column, .work-column {
    min-width: 0;
}

// Ниже 1300 px инспектор не влезает рядом со списком из четырёх колонок,
// поэтому колонки складываются одна под другой
@media (max-width: 1300px) {
    .dashboard {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
