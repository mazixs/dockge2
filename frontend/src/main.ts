// Dayjs init inside this, so it has to be the first import
import "../../common/util-common";

import { createApp, defineComponent, h } from "vue";
import App from "./App.vue";
import { router } from "./router";
import { FontAwesomeIcon } from "./icon.js";
import { i18n } from "./i18n";
import { ellipsisTitle } from "./directives/ellipsis-title";

// Dependencies
import "bootstrap";
import Vue3Toastify, { toast } from "vue3-toastify";
import "@xterm/xterm/lib/xterm.js";

// CSS
import "vue3-toastify/dist/index.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/main.scss";

// Minxins
import socket from "./mixins/socket";
import lang from "./mixins/lang";
import theme from "./mixins/theme";
import responsive from "./mixins/responsive";
import navigation from "./mixins/navigation";

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
app.directive("ellipsis-title", ellipsisTitle);
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
            responsive,
            navigation,
        ],
        // The session state lives in the socket mixin, so it is not repeated here
        computed: {

        },
        methods: {

            /**
             * Translate a message the server marked as translatable.
             *
             * The server marks every `Error` as translatable, but only the messages it
             * writes itself are keys. A failure from Docker or from Node arrives as an
             * English sentence that no catalogue contains, and `$t` hands such a string
             * straight back. The result was an English sentence inside a Russian
             * interface. Anything without a catalogue entry is therefore shown as the
             * raw detail of a translated frame, so the reader at least gets told in
             * their own language that something unexpected happened.
             * @param {string} key Key or raw message from the server
             * @param {object} values Named values of the key, if it has any
             * @returns {string} Text for the toast
             */
            translateServerMessage(key : string, values? : Record<string, unknown>) : string {
                if (!this.$te(key)) {
                    return this.$t("unexpectedServerError", { detail: key });
                }

                return values ? this.$t(key, values) : this.$t(key);
            },

            /**
             * Show success or error toast dependant on response status code
             * @param {object} res Response object
             * @returns {void}
             */
            toastRes(res: ToastResponse) {
                let msg = typeof res.msg === "string" ? res.msg : "";
                if (res.msgi18n) {
                    if (res.msg && typeof res.msg === "object") {
                        msg = this.translateServerMessage(res.msg.key, res.msg.values);
                    } else if (res.msg) {
                        msg = this.translateServerMessage(res.msg);
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
                toast.success(this.translateServerMessage(msg));
            },

            /**
             * Show an error toast
             * @param {string} msg Message to show
             * @returns {void}
             */
            toastError(msg : string) {
                toast.error(this.translateServerMessage(msg));
            },
        },
        render: () => h(App),
    });
}
