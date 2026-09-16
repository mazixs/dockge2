<template>
    <!-- Агенты - панель со списком серверов: строка на сервер, состояние чипом,
         как у стека, форма подключения последней строкой -->
    <section v-if="$root.isAdmin" class="panel">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="server" />{{ $t("dockgeAgent", 2) }}</h2>
            <span class="panel-meta">{{ $root.agentCount }}</span>
            <button v-if="!showAgentForm" class="btn btn-sm btn-primary" type="button" @click="showAgentForm = true">
                <font-awesome-icon icon="plus" />{{ $t("addAgent") }}
            </button>
        </div>

        <div class="panel-rows">
            <div v-for="(agentItem, endpoint) in $root.agentList" :key="endpoint" class="panel-row agent">
                <template v-if="$root.agentStatusList[endpoint]">
                    <span class="agent-identity">
                        <span class="agent-name">
                            <template v-if="endpoint === '' && agentItem.name === ''">{{ $t("thisServer") }}</template>
                            <template v-else-if="agentItem.name === ''">{{ endpoint }}</template>
                            <template v-else>{{ agentItem.name }}</template>
                        </span>
                        <span v-if="endpoint !== '' && agentItem.name !== ''" class="agent-url">{{ endpoint }}</span>
                    </span>

                    <StateChip
                        :state="agentState(endpoint)"
                        :label="$t(agentStatusLabel(endpoint))"
                        compact
                    />
                </template>

                <button v-if="endpoint !== ''" class="btn btn-sm btn-normal btn-danger-text" type="button" :aria-label="$t('removeAgent')" @click="showRemoveAgentDialog[agentItem.url] = !showRemoveAgentDialog[agentItem.url]">
                    <font-awesome-icon icon="trash" />
                </button>

                <BModal v-model="showRemoveAgentDialog[agentItem.url]" :okTitle="$t('removeAgent')" okVariant="danger" @ok="removeAgent(agentItem.url)">
                    <p>{{ agentItem.url }}</p>
                    {{ $t("removeAgentMsg") }}
                </BModal>
            </div>
        </div>

        <form v-if="showAgentForm" class="panel-body form-stack" @submit.prevent="addAgent">
            <div class="field">
                <label for="url" class="form-label">{{ $t("dockgeURL") }}</label>
                <input id="url" v-model="agent.url" type="url" class="form-control" required placeholder="http://">
            </div>

            <div class="field">
                <label for="username" class="form-label">{{ $t("Username") }}</label>
                <input id="username" v-model="agent.username" type="text" class="form-control" required>
            </div>

            <div class="field">
                <label for="password" class="form-label">{{ $t("Password") }}</label>
                <input id="password" v-model="agent.password" type="password" class="form-control" required autocomplete="new-password">
            </div>

            <div class="field">
                <label for="name" class="form-label">{{ $t("Friendly Name") }}</label>
                <input id="name" v-model="agent.name" type="text" class="form-control">
            </div>

            <div class="actions">
                <button type="submit" class="btn btn-sm btn-primary" :disabled="connectingAgent">
                    <template v-if="connectingAgent">{{ $t("connecting") }}</template>
                    <template v-else>{{ $t("connect") }}</template>
                </button>
                <button type="button" class="btn btn-sm btn-normal" :disabled="connectingAgent" @click="showAgentForm = false">{{ $t("cancel") }}</button>
            </div>
        </form>
    </section>
</template>

<script>
import StateChip from "../StateChip.vue";
import InterfaceIcon from "../InterfaceIcon.vue";

export default {
    components: { StateChip,
        InterfaceIcon },
    data() {
        return { showAgentForm: false,
            connectingAgent: false,
            showRemoveAgentDialog: {},
            agent: { url: "http://",
                username: "",
                password: "",
                name: "" } };
    },
    methods: {
        /**
         * Состояние агента в словаре системы: онлайн - работает, офлайн - сорвалось
         * @param {string} endpoint Адрес агента
         * @returns {string} Имя состояния для чипа
         */
        agentState(endpoint) {
            const status = this.$root.agentStatusList[endpoint];

            if (status === "online") {
                return "running";
            }

            return status === "offline" ? "failed" : "unknown";
        },

        /**
         * Ключ строки состояния: у промежуточных состояний сервер присылает свой
         * @param {string} endpoint Адрес агента
         * @returns {string} Ключ перевода
         */
        agentStatusLabel(endpoint) {
            const status = this.$root.agentStatusList[endpoint];

            if (status === "online") {
                return "agentOnline";
            }

            return status === "offline" ? "agentOffline" : status;
        },

        addAgent() {
            this.connectingAgent = true;
            this.$root.getSocket().emit("addAgent", this.agent, (res) => {
                this.$root.toastRes(res);
                this.connectingAgent = false;
                if (res.ok) {
                    this.showAgentForm = false;
                    this.agent = { url: "http://",
                        username: "",
                        password: "",
                        name: "" };
                }
            });
        },
        removeAgent(url) {
            this.$root.getSocket().emit("removeAgent", url, (res) => {
                this.$root.toastRes(res);
                if (res.ok) {
                    delete this.$root.allAgentStackList[new URL(url).host];
                }
            });
        },
    },
};
</script>
<style lang="scss" scoped>
.agent-identity {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
}

// В строке списка это имя сервера, а не часть фразы, поэтому с заглавной.
// Правило стоит здесь, а не в словаре: то же "этот сервер" в шапке стека читается
// внутри предложения ("Где живет: этот сервер"), и заглавной там быть не должно
.agent-name {
    display: inline-block;
    overflow-wrap: anywhere;
    font-size: var(--text-sm);

    &::first-letter {
        text-transform: uppercase;
    }
}

// Адрес - второстепенная строка под именем: он нужен, чтобы отличить два
// одинаково названных сервера, но не должен спорить с именем
.agent-url {
    overflow-wrap: anywhere;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}
</style>
