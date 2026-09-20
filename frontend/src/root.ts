import { defineComponent, h } from "vue";
import App from "./App.vue";
import { toast } from "vue3-toastify";
import type { DockgeRootApi } from "./root-api";

// Mixins
import socket from "./mixins/socket";
import lang from "./mixins/lang";
import theme from "./mixins/theme";
import responsive from "./mixins/responsive";
import navigation from "./mixins/navigation";

/** What a toast is given: the answer of a request, whichever event it came from */
interface ToastResponse {
    ok: boolean;
    msg?: string | { key: string; values?: Record<string, unknown> };
    msgi18n?: boolean;
}

/**
 * The component the application is mounted as.
 *
 * It holds nothing of its own beyond the toasts: the state lives in the mixins, so that
 * every screen reads the same session, the same stack list and the same requests.
 * @returns The root component definition
 */
export function rootApp() {
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
             * Text for a reason the server sent, shown in place rather than in a toast.
             *
             * This build names a catalogue entry and may pass values with it; an agent from
             * an older build sends a finished sentence in whatever language it was written
             * in. Both have to end up readable, and a missing reason has to fall back to
             * something that still tells the reader what happened.
             * @param {object|string|undefined} message Reason from the server
             * @param {string} fallback Catalogue key used when there is no reason at all
             * @returns {string} Text to show
             */
            serverText(message: { key: string, values?: Record<string, unknown> } | string | undefined, fallback: string) : string {
                if (!message) {
                    return this.$t(fallback);
                }
                if (typeof message === "object") {
                    return this.translateServerMessage(message.key, message.values);
                }
                return this.translateServerMessage(message);
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

/**
 * Whatever is given here has to offer everything `$root` promises
 * @template T The root component instance
 */
type OffersRootApi<T extends DockgeRootApi> = T;

/**
 * The root really does offer what every screen is promised through `$root`.
 *
 * `frontend/src/root-api.ts` describes that promise by hand, because a type that reads
 * the root while being part of it cannot be computed. This is the other half: the build
 * fails as soon as the root stops offering something the promise names, so the two
 * cannot drift apart unnoticed.
 */
export type RootApiCheck = OffersRootApi<InstanceType<ReturnType<typeof rootApp>>>;
