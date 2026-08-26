<template>
    <transition name="slide-fade" appear>
        <div>
            <h1 class="mb-3">{{ $t("terminal") }} - {{ serviceName }} ({{ stackName }})</h1>

            <div class="mb-3 d-flex align-items-center gap-2">
                <span class="badge bg-primary">{{ shell }}</span>

                <!-- The button always offers the other shell and starts a separate session -->
                <router-link :to="otherShellRoute" class="btn btn-normal">
                    {{ $t("switchToShell", [ otherShell ]) }}
                </router-link>
            </div>

            <Terminal
                :key="terminalName"
                class="terminal"
                :rows="20"
                mode="interactive"
                :name="terminalName"
                :stack-name="stackName"
                :service-name="serviceName"
                :shell="shell"
                :endpoint="endpoint"
            ></Terminal>
        </div>
    </transition>
</template>

<script>
import { CONTAINER_SHELLS, getContainerExecTerminalName, isContainerShell } from "../../../common/util-common";

export default {
    components: {
    },
    data() {
        return {

        };
    },
    computed: {
        stackName() {
            return this.$route.params.stackName;
        },
        endpoint() {
            return this.$route.params.endpoint || "";
        },

        /**
         * Shell of this session, an unknown value falls back to sh instead of reaching Docker
         * @returns {string} Shell name
         */
        shell() {
            const type = this.$route.params.type;
            return isContainerShell(type) ? type : CONTAINER_SHELLS[0];
        },

        /**
         * The shell the button switches to
         * @returns {string} Shell name
         */
        otherShell() {
            return this.shell === "bash" ? "sh" : "bash";
        },

        serviceName() {
            return this.$route.params.serviceName;
        },

        /**
         * Terminal name, which contains the shell so each shell has its own session
         * @returns {string} Terminal name
         */
        terminalName() {
            return getContainerExecTerminalName(this.endpoint, this.stackName, this.serviceName, this.shell, 0);
        },

        otherShellRoute() {
            const endpoint = this.$route.params.endpoint;

            const data = {
                name: "containerTerminal",
                params: {
                    stackName: this.stackName,
                    serviceName: this.serviceName,
                    type: this.otherShell,
                },
            };

            if (endpoint) {
                data.name = "containerTerminalEndpoint";
                data.params.endpoint = endpoint;
            }

            return data;
        },
    },
    mounted() {

    },
    methods: {

    }
};
</script>

<style scoped lang="scss">
.terminal {
    height: 410px;
}
</style>
