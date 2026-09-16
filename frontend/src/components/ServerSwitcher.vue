<template>
    <label class="server-switcher">
        <InterfaceIcon name="server" />
        <span class="visually-hidden">{{ $t("familiarExecutionServer") }}</span>
        <!-- Имя сервера обрезается по ширине контрола, поэтому оно же стоит подсказкой:
             у select ширину текста не измерить, здесь подсказка не по факту обрезки -->
        <select :value="$root.selectedEndpoint ?? '*'" :title="selectedServerLabel" :aria-label="$t('familiarExecutionServer')" @change="selectServer">
            <option value="*">{{ $t("familiarAllServers") }}</option>
            <option value="">{{ $t("thisServer") }}</option>
            <option v-for="server in remoteServers" :key="server.endpoint" :value="server.endpoint">{{ server.name || server.endpoint }}{{ $root.agentStatusList[server.endpoint] === 'online' ? '' : ` · ${$t('agentOffline')}` }}</option>
        </select>
    </label>
</template>
<script>
import InterfaceIcon from "./InterfaceIcon.vue";
export default {
    components: { InterfaceIcon },
    computed: {
        remoteServers() {
            return Object.values(this.$root.agentList).filter(server => server.endpoint);
        },

        /**
         * Имя выбранного сервера целиком - оно же уходит в подсказку
         * @returns {string} Имя сервера
         */
        selectedServerLabel() {
            const endpoint = this.$root.selectedEndpoint;

            if (endpoint === null || endpoint === undefined) {
                return this.$t("familiarAllServers");
            }

            if (endpoint === "") {
                return this.$t("thisServer");
            }

            const server = this.$root.agentList[endpoint];
            return server?.name || endpoint;
        },
    },
    methods: {
        selectServer(event) {
            this.$root.selectedEndpoint = event.target.value === "*" ? null : event.target.value;
            this.$router.push("/");
        },
    },
};
</script>
<style scoped lang="scss">
.server-switcher { display: inline-flex; align-items: center; gap: var(--gap-sm); margin: 0; color: var(--text-muted); min-width: 0; }
select { border: 0; background: transparent; color: var(--text-strong); font: inherit; font-size: var(--text-sm); min-height: var(--control-height); max-width: 200px; text-overflow: ellipsis; cursor: pointer; }
select option { background: var(--surface-panel); color: var(--text-strong); }
@media (max-width: 800px) { select { max-width: 140px; } }
</style>
