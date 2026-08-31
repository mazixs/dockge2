<template>
    <transition ref="tableContainer" name="slide-fade" appear>
        <div v-if="$route.name === 'DashboardHome'" class="home">
            <!-- Главный сценарий панели: вставить compose и развернуть.
                 Тот же бриф, что в слое, только встроенный - счётчики и кнопка
                 не повторяются, они уже есть в шапке -->
            <CreateStackSheet :inline="true" />

            <!-- Агенты: их нужно где-то добавлять, но это не главное на экране -->
            <details class="agents">
                <summary>{{ $t("dockgeAgent", 2) }} <span class="count">{{ $root.agentCount }}</span></summary>

                <div v-for="(agentItem, endpoint) in $root.agentList" :key="endpoint" class="agent">
                    <template v-if="$root.agentStatusList[endpoint]">
                        <span v-if="$root.agentStatusList[endpoint] === 'online'" class="badge bg-primary me-2">{{ $t("agentOnline") }}</span>
                        <span v-else-if="$root.agentStatusList[endpoint] === 'offline'" class="badge bg-danger me-2">{{ $t("agentOffline") }}</span>
                        <span v-else class="badge bg-secondary me-2">{{ $t($root.agentStatusList[endpoint]) }}</span>

                        <span v-if="endpoint === '' && agentItem.name === ''" class="me-2">{{ $t("thisServer") }}</span>
                        <span v-else-if="agentItem.name === ''" class="me-2">{{ endpoint }}</span>
                        <span v-else class="me-2">{{ agentItem.name }}</span>
                    </template>

                    <font-awesome-icon v-if="endpoint !== ''" class="ms-2 remove-agent" icon="trash" @click="showRemoveAgentDialog[agentItem.url] = !showRemoveAgentDialog[agentItem.url]" />

                    <BModal v-model="showRemoveAgentDialog[agentItem.url]" :okTitle="$t('removeAgent')" okVariant="danger" @ok="removeAgent(agentItem.url)">
                        <p>{{ agentItem.url }}</p>
                        {{ $t("removeAgentMsg") }}
                    </BModal>
                </div>

                <button v-if="!showAgentForm" class="btn btn-sm btn-normal" @click="showAgentForm = !showAgentForm">{{ $t("addAgent") }}</button>

                <form v-if="showAgentForm" class="agent-form" @submit.prevent="addAgent">
                    <div class="mb-2">
                        <label for="url" class="form-label">{{ $t("dockgeURL") }}</label>
                        <input id="url" v-model="agent.url" type="url" class="form-control" required placeholder="http://">
                    </div>

                    <div class="mb-2">
                        <label for="username" class="form-label">{{ $t("Username") }}</label>
                        <input id="username" v-model="agent.username" type="text" class="form-control" required>
                    </div>

                    <div class="mb-2">
                        <label for="password" class="form-label">{{ $t("Password") }}</label>
                        <input id="password" v-model="agent.password" type="password" class="form-control" required autocomplete="new-password">
                    </div>

                    <div class="mb-2">
                        <label for="name" class="form-label">{{ $t("Friendly Name") }}</label>
                        <input id="name" v-model="agent.name" type="text" class="form-control">
                    </div>

                    <button type="submit" class="btn btn-sm btn-primary" :disabled="connectingAgent">
                        <template v-if="connectingAgent">{{ $t("connecting") }}</template>
                        <template v-else>{{ $t("connect") }}</template>
                    </button>
                </form>
            </details>
        </div>
    </transition>
    <router-view ref="child" />
</template>

<script>
import CreateStackSheet from "../components/CreateStackSheet.vue";

export default {
    components: {
        CreateStackSheet,
    },
    props: {
        calculatedHeight: {
            type: Number,
            default: 0
        }
    },
    data() {
        return {
            page: 1,
            perPage: 25,
            initialPerPage: 25,
            paginationConfig: {
                hideCount: true,
                chunksNavigation: "scroll",
            },
            importantHeartBeatListLength: 0,
            displayedRecords: [],
            showAgentForm: false,
            showRemoveAgentDialog: {},
            showEditAgentNameDialog: {},
            connectingAgent: false,
            agent: {
                url: "http://",
                username: "",
                password: "",
                name: "",
                updatedName: "",
            }
        };
    },

    watch: {
        perPage() {
            this.$nextTick(() => {
                this.getImportantHeartbeatListPaged();
            });
        },

        page() {
            this.getImportantHeartbeatListPaged();
        },
    },

    mounted() {
        this.initialPerPage = this.perPage;

        window.addEventListener("resize", this.updatePerPage);
        this.updatePerPage();
    },

    beforeUnmount() {
        window.removeEventListener("resize", this.updatePerPage);
    },

    methods: {

        addAgent() {
            this.connectingAgent = true;
            this.$root.getSocket().emit("addAgent", this.agent, (res) => {
                this.$root.toastRes(res);

                if (res.ok) {
                    this.showAgentForm = false;
                    this.agent = {
                        url: "http://",
                        username: "",
                        password: "",
                    };
                }

                this.connectingAgent = false;
            });
        },

        removeAgent(url) {
            this.$root.getSocket().emit("removeAgent", url, (res) => {
                if (res.ok) {
                    this.$root.toastRes(res);

                    let urlObj = new URL(url);
                    let endpoint = urlObj.host;

                    // Remove the stack list and status list of the removed agent
                    delete this.$root.allAgentStackList[endpoint];
                }
            });
        },

        updateName(url, updatedName) {
            this.$root.getSocket().emit("updateAgent", url, updatedName, (res) => {
                this.$root.toastRes(res);

                if (res.ok) {
                    this.showAgentForm = false;
                    this.agent = {
                        updatedName: "",
                    };
                }
            });
        },

        /**
         * Updates the displayed records when a new important heartbeat arrives.
         * @param {object} heartbeat - The heartbeat object received.
         * @returns {void}
         */
        onNewImportantHeartbeat(heartbeat) {
            if (this.page === 1) {
                this.displayedRecords.unshift(heartbeat);
                if (this.displayedRecords.length > this.perPage) {
                    this.displayedRecords.pop();
                }
                this.importantHeartBeatListLength += 1;
            }
        },

        /**
         * Retrieves the length of the important heartbeat list for all monitors.
         * @returns {void}
         */
        getImportantHeartbeatListLength() {
            this.$root.getSocket().emit("monitorImportantHeartbeatListCount", null, (res) => {
                if (res.ok) {
                    this.importantHeartBeatListLength = res.count;
                    this.getImportantHeartbeatListPaged();
                }
            });
        },

        /**
         * Retrieves the important heartbeat list for the current page.
         * @returns {void}
         */
        getImportantHeartbeatListPaged() {
            const offset = (this.page - 1) * this.perPage;
            this.$root.getSocket().emit("monitorImportantHeartbeatListPaged", null, offset, this.perPage, (res) => {
                if (res.ok) {
                    this.displayedRecords = res.data;
                }
            });
        },

        /**
         * Updates the number of items shown per page based on the available height.
         * @returns {void}
         */
        updatePerPage() {
            const tableContainer = this.$refs.tableContainer;
            const tableContainerHeight = tableContainer.offsetHeight;
            const availableHeight = window.innerHeight - tableContainerHeight;
            const additionalPerPage = Math.floor(availableHeight / 58);

            if (additionalPerPage > 0) {
                this.perPage = Math.max(this.initialPerPage, this.perPage + additionalPerPage);
            } else {
                this.perPage = this.initialPerPage;
            }

        },
    }
};
</script>

<style lang="scss" scoped>
.home {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
    max-width: 1100px;
}

// Агенты свёрнуты: на главной они нужны редко, а место нужно полю вставки
.agents {
    border-top: 1px solid var(--line-hair);
    padding-top: var(--gap-sm);

    summary {
        font-size: var(--text-sm);
        color: var(--text-faint);
        cursor: pointer;
        min-height: var(--control-height);
        display: flex;
        align-items: center;
        gap: var(--gap-sm);

        &:focus-visible {
            outline: var(--focus-ring);
            outline-offset: var(--focus-offset);
        }
    }

    .count {
        font-family: var(--font-mono);
    }
}

.agent {
    display: flex;
    align-items: center;
    margin: var(--gap-sm) 0;
    font-size: var(--text-sm);
}

.agent-form {
    max-width: 420px;
    margin-top: var(--gap-sm);
}

.remove-agent {
    cursor: pointer;
    color: var(--text-faint);

    &:hover {
        color: var(--state-failed);
    }
}
</style>
