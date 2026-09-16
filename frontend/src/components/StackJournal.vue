<template>
    <!-- Журнал: вывод стека и ничего больше. Оболочки контейнеров живут во
         вкладке терминала, поэтому здесь нечего выбирать и не во что печатать -->
    <section class="panel journal">
        <div class="panel-bar">
            <h2 class="panel-title">
                <InterfaceIcon name="logs" />{{ $t("logsOf", [ stackName ]) }}
            </h2>

            <!-- Связь названа словом, а не только цветом: без нее журнал молчит,
                 и человек должен знать, что молчит канал, а не стек -->
            <StateChip
                class="journal-state" :state="connected ? 'running' : 'failed'"
                :label="$t(connected ? 'sessionLive' : 'agentOffline')"
            />
        </div>

        <div ref="body" class="panel-console journal-body">
            <Terminal
                ref="terminal"
                class="journal-terminal"
                :name="terminalName"
                :endpoint="endpoint"
                :stack-name="stackName"
                mode="displayOnly"
                :rows="20"
            />
        </div>

        <p class="panel-foot">
            <font-awesome-icon icon="info-circle" />{{ $t("sessionLogsNote") }}
        </p>
    </section>
</template>

<script>
import Terminal from "./Terminal.vue";
import StateChip from "./StateChip.vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import { getCombinedTerminalName } from "../../../common/util-common";

export default {
    components: {
        Terminal,
        StateChip,
        InterfaceIcon,
    },
    props: {
        stackName: {
            type: String,
            required: true,
        },

        endpoint: {
            type: String,
            default: "",
        },
    },
    computed: {
        /** Имя общего терминала стека: по нему сервер шлет вывод всех сервисов */
        terminalName() {
            return getCombinedTerminalName(this.endpoint, this.stackName);
        },

        /**
         * Есть ли канал, по которому идет вывод. Локальный стек слушает наш сокет,
         * стек агента - соединение с этим агентом
         */
        connected() {
            if (this.endpoint === "") {
                return this.$root.socketIO.connected;
            }

            return this.$root.agentStatusList[this.endpoint] === "online";
        },
    },
    mounted() {
        this.$root.emitAgent(this.endpoint, "joinCombinedTerminal", this.stackName, (res) => {
            if (!res?.ok) {
                this.$root.toastRes(res);
            }
        });

        // Высота консоли зависит от экрана. Когда окно меняет размер, xterm
        // остается в старой сетке и налезает на подпись, поэтому область под
        // наблюдением: изменилась - вывод подгоняется заново
        this.observer = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                this.refit();
            });
        });
        this.observer.observe(this.$refs.body);
    },
    beforeUnmount() {
        this.observer?.disconnect();
    },
    methods: {
        /** Подогнать вывод под область: скрытый xterm не знает своего размера */
        refit() {
            this.$refs.terminal?.updateTerminalSize?.();
        },

        /**
         * Показанная вкладка подгоняет вывод. Фокус журналу не нужен: он ничего
         * не принимает, а забранный фокус увел бы клавиатуру со страницы
         * @returns {void}
         */
        fitActive() {
            this.refit();
        },
    },
};
</script>

<style lang="scss" scoped>
// Журнал собран из общей анатомии панели. Свое здесь одно: панель растет до
// низа страницы, и консоль показывает столько вывода, сколько вмещает экран,
// а не столько, сколько задано числом строк
.journal {
    flex: 1;
}

.journal-state {
    flex: none;
}

.journal-body {
    flex: 1;
    min-height: 280px;
}

.journal-terminal {
    height: 100%;
}
</style>
