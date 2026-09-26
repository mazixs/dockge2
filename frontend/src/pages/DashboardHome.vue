<template>
    <div v-if="$route.name === 'DashboardHome'"><StabilityDashboard /></div>
    <router-view v-else :key="viewKey" />
</template>

<script lang="ts">
import { defineComponent } from "vue";
import StabilityDashboard from "../components/StabilityDashboard.vue";

// Вкладки стека - один и тот же компонент на разных путях, поэтому ключ вида
// не может быть путем: с ним каждая смена вкладки пересоздавала страницу,
// открытая оболочка умирала, а журнал перечитывался с нуля
const STACK_TABS = [ "stackInspector", "stackInspectorEndpoint", "stackFiles", "stackLogs", "stackTerminal" ];

export default defineComponent({
    components: { StabilityDashboard },
    computed: {
        /**
         * Ключ вида: у стека все вкладки - одна страница, смену стека инспектор
         * отслеживает сам. Сервер в адресе меняет источник данных целиком,
         * и здесь пересоздание как раз нужно
         * @returns {string} Ключ router-view
         */
        viewKey() : string {
            if (STACK_TABS.includes(String(this.$route.name))) {
                return `stack:${this.$route.params.endpoint ?? ""}`;
            }

            return this.$route.path;
        },
    },
});
</script>
