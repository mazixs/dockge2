<template>
    <transition name="slide-fade" appear>
        <div class="page page-fill">
            <h1>{{ $t("terminal") }}</h1>

            <!-- Оболочка контейнера - панель той же анатомии, что терминал стека:
                 сервис и оболочка в шапке, переключение оболочки рядом с именем -->
            <section class="panel">
                <div class="panel-bar">
                    <h2 class="panel-title mono"><InterfaceIcon name="terminal" />{{ serviceName }} · {{ shell }}</h2>
                    <span class="panel-meta">{{ stackName }}</span>
                    <router-link :to="otherShellRoute" class="btn btn-sm btn-normal">
                        {{ $t("switchToShell", [ otherShell ]) }}
                    </router-link>
                </div>

                <div class="panel-console">
                    <Terminal
                        :key="terminalName"
                        class="session-terminal"
                        :rows="20"
                        mode="interactive"
                        :name="terminalName"
                        :stack-name="stackName"
                        :service-name="serviceName"
                        :shell="shell"
                        :endpoint="endpoint"
                    ></Terminal>
                </div>

                <p class="panel-foot"><font-awesome-icon icon="info-circle" />{{ $t("sessionShellNote") }}</p>
            </section>
        </div>
    </transition>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import type { RouteLocationNamedRaw, RouteParamsRaw } from "vue-router";
import Terminal from "../components/Terminal.vue";
import InterfaceIcon from "../components/InterfaceIcon.vue";
import { CONTAINER_SHELLS, getContainerExecTerminalName, isContainerShell, type ContainerShell } from "../../../common/util-common";

/**
 * A route parameter as text: none of the terminal routes repeats a parameter
 * @param value Parameter of the current route
 * @returns The parameter, empty when the route has none
 */
function textParam(value : unknown) : string {
    return typeof value === "string" ? value : "";
}

export default defineComponent({
    components: {
        Terminal,
        InterfaceIcon,
    },
    computed: {
        stackName() : string {
            return textParam(this.$route.params.stackName);
        },
        endpoint() : string {
            return textParam(this.$route.params.endpoint);
        },

        /**
         * Shell of this session, an unknown value falls back to sh instead of reaching Docker
         * @returns {string} Shell name
         */
        shell() : ContainerShell {
            const type = this.$route.params.type;
            return isContainerShell(type) ? type : CONTAINER_SHELLS[0];
        },

        /**
         * The shell the button switches to
         * @returns {string} Shell name
         */
        otherShell() : ContainerShell {
            return this.shell === "bash" ? "sh" : "bash";
        },

        serviceName() : string {
            return textParam(this.$route.params.serviceName);
        },

        /**
         * Terminal name, which contains the shell so each shell has its own session
         * @returns {string} Terminal name
         */
        terminalName() : string {
            return getContainerExecTerminalName(this.endpoint, this.stackName, this.serviceName, this.shell, 0);
        },

        otherShellRoute() : RouteLocationNamedRaw {
            const endpoint = this.$route.params.endpoint;

            const data : { name : string, params : RouteParamsRaw } = {
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
});
</script>

<style scoped lang="scss">
// Высоту тела дает `.page-fill`; здесь только то, что оболочка занимает его целиком
.session-terminal {
    height: 100%;
}
</style>
