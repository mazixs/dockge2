<template>
    <div class="container-fluid">
        <div class="row">
            <div v-if="!$root.isMobile && !fullWidth" class="col-12 col-md-4 col-xl-3">
                <div>
                    <button class="btn btn-primary mb-3" type="button" @click="$root.openCreateStack && $root.openCreateStack()">
                        <font-awesome-icon icon="plus" /> {{ $t("deployStackAction") }}
                    </button>
                </div>
                <StackList :scrollbar="true" />
            </div>

            <div ref="container" class="mb-3" :class="fullWidth ? 'col-12' : 'col-12 col-md-8 col-xl-9'">
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" :calculatedHeight="height" />
            </div>
        </div>
    </div>
</template>

<script>

import StackList from "../components/StackList.vue";

export default {
    components: {
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
.container-fluid {
    width: 98%;
}
</style>
