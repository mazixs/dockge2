<template>
    <transition name="slide-fade" appear>
        <div v-if="!processing" class="page page-fill">
            <h1>{{ $t("console") }}</h1>

            <!-- Консоль сервера - та же панель, что терминал стека: имя в шапке,
                 черная поверхность только внутри тела. Шапка называет сервер, а не
                 повторяет имя страницы: консоль бывает и на агенте, и слово
                 "Консоль" дважды подряд ничего не добавляет -->
            <section v-if="enableConsole" class="panel">
                <div class="panel-bar">
                    <h2 class="panel-title"><InterfaceIcon name="terminal" />{{ serverLabel }}</h2>
                </div>

                <div class="panel-console">
                    <Terminal class="console-terminal" :rows="20" mode="mainTerminal" name="console" :endpoint="endpoint"></Terminal>
                </div>
            </section>

            <!-- The console is off: the screen says why and who turns it on. Only an owner
                 of this panel can, so only an owner gets the way to the setting -->
            <!-- No answer is not a refusal: the console may well be on -->
            <EmptyState
                v-else-if="unknown"
                class="console-off"
                :title="$t('consoleUnknownTitle')"
                :hint="$t('consoleUnknownHint')"
            >
                <button type="button" class="btn btn-normal" @click="check">{{ $t("retry") }}</button>
            </EmptyState>
            <EmptyState
                v-else-if="ownersOnly"
                class="console-off"
                :title="$t('consoleOwnersOnlyTitle')"
                :hint="$t(endpoint && $root.isAdmin ? 'consoleOwnersOnlyHintAgent' : 'consoleOwnersOnlyHint')"
            />
            <EmptyState
                v-else
                class="console-off"
                :title="$t('consoleDisabledTitle')"
                :hint="disabledHint"
            >
                <router-link v-if="!endpoint && $root.isAdmin" to="/settings/security" class="btn btn-normal">{{ $t("consoleOpenSettings") }}</router-link>
            </EmptyState>
        </div>
    </transition>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import Terminal from "../components/Terminal.vue";
import EmptyState from "../components/EmptyState.vue";
import InterfaceIcon from "../components/InterfaceIcon.vue";

export default defineComponent({
    components: {
        Terminal,
        EmptyState,
        InterfaceIcon,
    },
    data() {
        return {
            processing: true,
            enableConsole: false,
            /** The console is on, but an owner keeps it to owners */
            ownersOnly: false,
            /** The server did not answer, so whether the console is on is not known */
            unknown: false,
        };
    },
    computed: {
        endpoint() : string {
            const endpoint = this.$route.params.endpoint;
            return typeof endpoint === "string" ? endpoint : "";
        },

        /** Чей это сервер: консоль открывается и на своей машине, и на агенте */
        serverLabel() : string {
            if (!this.endpoint) {
                return this.$root.info.primaryHostname || "localhost";
            }

            return this.$root.endpointDisplayFunction(this.endpoint) || this.endpoint;
        },

        /** An agent is configured on its own server, this panel only by an owner */
        disabledHint() : string {
            if (this.endpoint) {
                return this.$t("consoleDisabledHintAgent");
            }
            return this.$t(this.$root.isAdmin ? "consoleDisabledHintOwner" : "consoleDisabledHintOperator");
        },
    },
    mounted() {
        this.check();
    },
    methods: {
        /**
         * Ask the server whether the console is on for this account
         * @returns {void}
         */
        check() {
            this.processing = true;
            this.$root.emitAgentRequest(this.endpoint, "checkMainTerminal", []).then((res) => {
                this.enableConsole = res.ok;
                // A console that is simply off answers without a reason, a refusal carries one
                this.unknown = !res.ok && "unknown" in res && res.unknown === true;
                this.ownersOnly = !res.ok && "msg" in res && res.msg === "consoleOwnersOnly";
                this.processing = false;
            });
        },
    },
});
</script>

<style scoped lang="scss">
// Высоту тела дает `.page-fill`; здесь только то, что терминал занимает его целиком
.console-terminal {
    height: 100%;
}

// Пустой экран занимает место терминала, поэтому и выглядит как панель, а не
// как предупреждение поверх страницы
.console-off {
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);
    background-color: var(--surface-panel);
}
</style>
