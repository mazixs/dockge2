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
                <!-- Имя меняется на месте: адрес, логин и пароль остаются прежними -->
                <form v-if="renaming === endpoint" class="agent-rename" @submit.prevent="saveName(agentItem.url ?? '')" @keydown.esc.prevent="renaming = null">
                    <label :for="`agent-name-${endpoint}`" class="visually-hidden">{{ $t("friendlyName") }}</label>
                    <input :id="`agent-name-${endpoint}`" ref="nameInput" v-model="newName" type="text" class="form-control form-control-sm" maxlength="255" :placeholder="endpoint" :disabled="savingName">
                    <button type="submit" class="btn btn-sm btn-primary" :disabled="savingName">{{ $t("save") }}</button>
                    <button type="button" class="btn btn-sm btn-normal" :disabled="savingName" @click="renaming = null">{{ $t("cancel") }}</button>
                </form>

                <template v-else-if="$root.agentStatusList[endpoint]">
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

                <button v-if="endpoint !== '' && renaming !== endpoint" class="btn btn-sm btn-normal" type="button" :aria-label="`${$t('renameAgent')}: ${agentItem.name || endpoint}`" :title="$t('renameAgent')" @click="startRename(String(endpoint), agentItem.name)">
                    <font-awesome-icon icon="pen" />
                </button>
                <button v-if="endpoint !== '' && renaming !== endpoint" class="btn btn-sm btn-normal btn-danger-text" type="button" :aria-label="$t('removeAgent')" @click="removing = agentItem.url ?? ''">
                    <font-awesome-icon icon="trash" />
                </button>

                <BModal
                    :model-value="removing !== null && removing === agentItem.url" :okTitle="$t('removeAgent')" okVariant="danger"
                    @update:model-value="(open : boolean) => { if (!open) removing = null; }" @ok="removeAgent(agentItem.url ?? '')"
                >
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
                <label for="username" class="form-label">{{ $t("username") }}</label>
                <input id="username" v-model="agent.username" type="text" class="form-control" required>
            </div>

            <div class="field">
                <label for="password" class="form-label">{{ $t("password") }}</label>
                <input id="password" v-model="agent.password" type="password" class="form-control" required autocomplete="new-password">
            </div>

            <div class="field">
                <label for="name" class="form-label">{{ $t("friendlyName") }}</label>
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

<script lang="ts">
import { defineComponent, nextTick } from "vue";
import StateChip from "../StateChip.vue";
import InterfaceIcon from "../InterfaceIcon.vue";
import type { SocketResponse } from "../../mixins/socket";

/** How long a change of the agent list waits for the panel to answer */
const REQUEST_TIMEOUT_MS = 15_000;

export default defineComponent({
    components: { StateChip,
        InterfaceIcon },
    data() {
        return { showAgentForm: false,
            connectingAgent: false,
            /** Адрес агента, удаление которого ждет подтверждения */
            removing: null as string | null,
            /** Адрес агента, чье имя сейчас правится */
            renaming: null as string | null,
            newName: "",
            savingName: false,
            agent: { url: "http://",
                username: "",
                password: "",
                name: "" } };
    },
    methods: {
        /**
         * Состояние агента в словаре системы: онлайн - работает, офлайн - сорвалось
         * @param endpoint Адрес агента
         * @returns Имя состояния для чипа
         */
        agentState(endpoint : string | number) : string {
            const status = this.$root.agentStatusList[endpoint];

            if (status === "online") {
                return "running";
            }

            return status === "offline" ? "failed" : "unknown";
        },

        /**
         * Ключ строки состояния: у промежуточных состояний сервер присылает свой
         * @param endpoint Адрес агента
         * @returns Ключ перевода
         */
        agentStatusLabel(endpoint : string | number) : string {
            const status = this.$root.agentStatusList[endpoint] ?? "";

            if (status === "online") {
                return "agentOnline";
            }

            return status === "offline" ? "agentOffline" : status;
        },

        addAgent() {
            this.connectingAgent = true;
            this.$root.getSocket().timeout(REQUEST_TIMEOUT_MS).emit("addAgent", this.agent, (error : Error | null, res : SocketResponse) => {
                this.connectingAgent = false;
                this.$root.toastRes(error ? { ok: false,
                    msg: "requestResultUnknown",
                    msgi18n: true } : { ...res,
                    ok: res.ok === true });
                if (!error && res.ok) {
                    this.showAgentForm = false;
                    this.agent = { url: "http://",
                        username: "",
                        password: "",
                        name: "" };
                }
            });
        },

        removeAgent(url : string) {
            this.$root.getSocket().emit("removeAgent", url, (res : SocketResponse) => {
                this.$root.toastRes({ ...res,
                    ok: res.ok === true });
                if (res.ok) {
                    delete this.$root.allAgentStackList[new URL(url).host];
                }
            });
        },

        /**
         * Открыть правку имени в строке агента
         * @param endpoint Адрес агента
         * @param name Имя сейчас, пустое - если его не давали
         * @returns Промис, который ждет поле ввода
         */
        async startRename(endpoint : string, name : string) : Promise<void> {
            this.renaming = endpoint;
            this.newName = name;
            await nextTick();
            const input = this.$refs.nameInput as HTMLInputElement[] | HTMLInputElement | undefined;
            (Array.isArray(input) ? input[0] : input)?.focus();
        },

        /**
         * Сохранить имя; пустое имя возвращает показ адреса
         * @param url Адрес агента, по которому он записан
         */
        saveName(url : string) {
            this.savingName = true;
            this.$root.getSocket().timeout(REQUEST_TIMEOUT_MS).emit("updateAgent", url, this.newName.trim(), (error : Error | null, res : SocketResponse) => {
                this.savingName = false;
                // Без ответа имя могло и сохраниться: список агентов придет сам и покажет, какое оно
                this.$root.toastRes(error ? { ok: false,
                    msg: "requestResultUnknown",
                    msgi18n: true } : { ...res,
                    ok: res.ok === true });
                if (!error && res.ok) {
                    this.renaming = null;
                }
            });
        },
    },
});
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

.agent-rename {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-sm);
    min-width: 0;

    input {
        flex: 1 1 12rem;
        min-width: 0;
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
