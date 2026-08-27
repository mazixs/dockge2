// Dayjs init inside this, so it has to be the first import
import "../../common/util-common";

import { createApp, defineComponent, h } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { FontAwesomeIcon } from "./icon.js";
import { i18n } from "./i18n";

// Dependencies
import "bootstrap";
import Vue3Toastify, { toast } from "vue3-toastify";
import "@xterm/xterm/lib/xterm.js";

// CSS
import "@fontsource/jetbrains-mono";
import "vue3-toastify/dist/index.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/main.scss";

// Minxins
import socket from "./mixins/socket";
import lang from "./mixins/lang";
import theme from "./mixins/theme";

interface ToastResponse {
    ok: boolean;
    msg?: string | { key: string; values?: Record<string, unknown> };
    msgi18n?: boolean;
}

// Set Title
document.title = document.title + " - " + location.host;

const app = createApp(rootApp());

app.use(Vue3Toastify, {
    position: toast.POSITION.BOTTOM_RIGHT,
    containerClassName: "toast-container",
    closeButton: true,
});
app.use(router);
app.use(i18n);
app.component("FontAwesomeIcon", FontAwesomeIcon);
app.mount("#app");

/**
 * Root Vue component
 */
function rootApp() {
    return defineComponent({
        mixins: [
            socket,
            lang,
            theme,
        ],
        // The session state lives in the socket mixin, so it is not repeated here
        computed: {

        },
        methods: {

            /**
             * Show success or error toast dependant on response status code
             * @param {object} res Response object
             * @returns {void}
             */
            toastRes(res: ToastResponse) {
                let msg = typeof res.msg === "string" ? res.msg : "";
                if (res.msgi18n) {
                    if (res.msg && typeof res.msg === "object") {
                        msg = res.msg.values
                            ? this.$t(res.msg.key, res.msg.values)
                            : this.$t(res.msg.key);
                    } else if (res.msg) {
                        msg = this.$t(res.msg);
                    }
                }

                if (res.ok) {
                    toast.success(msg);
                } else {
                    toast.error(msg);
                }
            },
            /**
             * Show a success toast
             * @param {string} msg Message to show
             * @returns {void}
             */
            toastSuccess(msg : string) {
                toast.success(this.$t(msg));
            },

            /**
             * Show an error toast
             * @param {string} msg Message to show
             * @returns {void}
             */
            toastError(msg : string) {
                toast.error(this.$t(msg));
            },
        },
        render: () => h(App),
    });
}
