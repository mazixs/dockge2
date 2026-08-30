<template>
    <transition name="slide-fade" appear>
        <div v-if="!processing">
            <h1 class="mb-3">{{ $t("console") }}</h1>

            <Terminal v-if="enableConsole" class="terminal" :rows="20" mode="mainTerminal" name="console" :endpoint="endpoint"></Terminal>

            <!-- Консоль выключена: экран объясняет, почему её нет и чем она включается -->
            <EmptyState
                v-else
                class="console-off"
                :title="$t('consoleDisabledTitle')"
                :hint="$t('consoleDisabledHint')"
            >
                <router-link to="/settings">{{ $t("openSettings") }}</router-link>
            </EmptyState>
        </div>
    </transition>
</template>

<script>
import EmptyState from "../components/EmptyState.vue";

export default {
    components: {
        EmptyState,
    },
    data() {
        return {
            processing: true,
            enableConsole: false,
        };
    },
    computed: {
        endpoint() {
            return this.$route.params.endpoint || "";
        },
    },
    mounted() {
        this.$root.emitAgent(this.endpoint, "checkMainTerminal", (res) => {
            this.enableConsole = res.ok;
            this.processing = false;
        });
    },
    methods: {

    }
};
</script>

<style scoped lang="scss">
.terminal {
    height: 410px;
}

// Пустой экран занимает место терминала, поэтому и выглядит как панель, а не
// как предупреждение поверх страницы
.console-off {
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);
    background-color: var(--surface-panel);
}
</style>
