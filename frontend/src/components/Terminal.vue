<template>
    <div class="terminal-box">
        <div v-pre ref="terminal" class="main-terminal"></div>

        <TerminalContextMenu
            :visible="contextMenuVisible"
            :position="contextMenuPosition"
            :message="contextMenuMessage"
            @paste="pasteFromClipboard"
            @close="closeContextMenu"
        />
    </div>
</template>

<script>
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_COLS, TERMINAL_ROWS } from "../../../common/util-common";
import TerminalContextMenu from "./TerminalContextMenu.vue";

/** Размер и семейство консольного шрифта: ими же терминал меряет знакоместо */
const CONSOLE_FONT_SIZE = 14;
const CONSOLE_FONT_FAMILY = "'IBM Plex Mono', ui-monospace, monospace";
const CONSOLE_FONT_FACE = "'IBM Plex Mono'";

export default {
    /**
     * @type {Terminal}
     */
    terminal: null,
    components: {
        TerminalContextMenu,
    },
    props: {
        name: {
            type: String,
            required: true,
        },

        endpoint: {
            type: String,
            required: true,
        },

        // Require if mode is interactive
        stackName: {
            type: String,
            default: "",
        },

        // Require if mode is interactive
        serviceName: {
            type: String,
            default: "",
        },

        // Require if mode is interactive
        shell: {
            type: String,
            default: "bash",
        },

        rows: {
            type: Number,
            default: TERMINAL_ROWS,
        },

        cols: {
            type: Number,
            default: TERMINAL_COLS,
        },

        // Mode
        // displayOnly: Only display terminal output
        // mainTerminal: Allow input limited commands and output
        // interactive: Free input and output
        mode: {
            type: String,
            default: "displayOnly",
        }
    },
    emits: [ "has-data" ],
    data() {
        return {
            first: true,
            terminalInputBuffer: "",
            cursorPosition: 0,
            contextMenuVisible: false,
            contextMenuPosition: { x: 0,
                y: 0 },
            contextMenuMessage: "",
        };
    },
    created() {

    },
    mounted() {
        // Ширина знакоместа меряется один раз, при открытии терминала. Если консольный
        // шрифт к этому моменту не загружен, xterm померяет запасной моноширинный и
        // разложит сетку под него: колонки встанут не по ширине панели, а текст - не по
        // колонкам, и так и останется до первого изменения размера окна
        this.consoleFontReady().then(() => {
            // Пока грузился шрифт, вкладку могли закрыть
            if (this.$refs.terminal) {
                this.openTerminal();
            }
        });
    },

    beforeUnmount() {
        // The template ref is already gone in unmounted(), so the listener is removed here
        this.$refs.terminal?.removeEventListener("contextmenu", this.handleContextMenu);
    },

    unmounted() {
        window.removeEventListener("resize", this.onResizeEvent); // Remove the resize event listener from the window object.

        // Tell the server this client is gone. The server ends a container shell that has
        // no clients left and only drops the client from the others.
        if (this.name) {
            this.$root.emitAgent(this.endpoint, "terminalLeave", this.name, () => {});
        }

        this.$root.unbindTerminal(this.name);

        // Терминала может и не быть: вкладку закрыли, пока грузился консольный шрифт
        this.terminal?.textarea?.removeEventListener("paste", this.handleNativePaste);
        this.terminal?.dispose();
        this.$refs.terminal?.removeEventListener("contextmenu", this.handleContextMenu);
    },

    methods: {
        /**
         * Дождаться консольного шрифта, чтобы замер знакоместа шел по нему
         * @returns {Promise<void>} Разрешается, когда шрифт загружен или отказал
         */
        async consoleFontReady() {
            try {
                // Шрифт грузится по требованию, поэтому мало дождаться document.fonts.ready:
                // без явного запроса на экране без моноширинного текста он и не начнет грузиться
                await document.fonts.load(`${CONSOLE_FONT_SIZE}px ${CONSOLE_FONT_FACE}`);
                await document.fonts.ready;
            } catch {
                // Шрифт не обязателен: без него терминал рисуется запасным моноширинным
            }
        },

        /**
         * Собрать терминал и подключить его к сессии
         * @returns {void}
         */
        openTerminal() {
            let cursorBlink = true;

            if (this.mode === "displayOnly") {
                cursorBlink = false;
            }

            this.terminal = new Terminal({
                fontSize: CONSOLE_FONT_SIZE,
                fontFamily: CONSOLE_FONT_FAMILY,
                cursorBlink,
                // Журнал и окно запуска - вывод, а не ввод: скрытое поле xterm не должно
                // принимать набранное. Печатать там все равно было некуда - ни `onKey`,
                // ни `onData` для этого режима не подключены
                disableStdin: this.mode === "displayOnly",
                cols: this.cols,
                rows: this.rows,
                theme: this.consoleTheme(),
            });

            if (this.mode === "mainTerminal") {
                this.mainTerminalConfig();
            } else if (this.mode === "interactive") {
                this.interactiveTerminalConfig();
            }

            //this.terminal.loadAddon(new WebLinksAddon());

            // Bind to a div
            this.terminal.open(this.$refs.terminal);

            // Фокус забирает только тот терминал, в который печатают. Журнал уносил
            // курсор внутрь вывода сразу при открытии вкладки, а окно запуска - вместо
            // своей кнопки закрытия
            if (this.mode !== "displayOnly") {
                this.terminal.focus();
            }

            // Right click opens an explicit menu instead of pasting immediately
            this.$refs.terminal.addEventListener("contextmenu", this.handleContextMenu);

            // Ctrl+V, Ctrl+Shift+V and Cmd+V are left to the browser, which pastes into the
            // hidden xterm textarea. That keeps the exact text and never sends a stray "v".
            this.terminal.attachCustomKeyEventHandler((event) => {
                const isPasteShortcut = event.key.toLowerCase() === "v" && (event.ctrlKey || event.metaKey);

                if (isPasteShortcut && event.type === "keydown") {
                    return false;
                }

                // В выводе Tab уводит фокус дальше по странице, а не проваливается
                // в терминал. В оболочке контейнера и в ограниченной консоли Tab -
                // рабочая клавиша (дополнение имени), и туда он идет как прежде
                if (this.mode === "displayOnly" && event.key === "Tab") {
                    return false;
                }

                return true;
            });

            // The hidden textarea receives the real paste event, used by the limited console
            if (this.mode === "mainTerminal" && this.terminal.textarea) {
                this.terminal.textarea.addEventListener("paste", this.handleNativePaste);
            }

            // Add selection handler for copy to clipboard
            this.terminal.onSelectionChange(() => {
                this.handleSelection();
            });

            // Notify parent component when data is received
            this.terminal.onCursorMove(() => {
                console.debug("onData triggered");
                if (this.first) {
                    this.$emit("has-data");
                    this.first = false;
                }
            });

            this.bind();

            // Create a new Terminal
            if (this.mode === "mainTerminal") {
                this.$root.emitAgent(this.endpoint, "mainTerminal", this.name, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            } else if (this.mode === "interactive") {
                console.debug("Create Interactive terminal:", this.name);
                this.$root.emitAgent(this.endpoint, "interactiveTerminal", this.stackName, this.serviceName, this.shell, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            }
            // Fit the terminal width to the div container size after terminal is created.
            this.updateTerminalSize();
        },

        /**
         * Colours of the console surface, taken from the design tokens
         * @returns {object} xterm theme: xterm draws pure black by default, and a
         * black rectangle inside the near-black panel showed a visible seam
         */
        consoleTheme() {
            const root = getComputedStyle(document.documentElement);
            const token = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
            const surface = token("--surface-console", "#0b0e12");
            const text = token("--text-on-console", "#dfe5ee");

            return {
                background: surface,
                foreground: text,
                cursor: text,
                cursorAccent: surface,
                selectionBackground: token("--surface-console-selection", "rgba(157, 172, 249, .32)"),
            };
        },

        bind(endpoint, name) {
            // Workaround: normally this.name should be set, but it is not sometimes, so we use the parameter, but eventually this.name and name must be the same name
            if (name) {
                this.$root.unbindTerminal(name);
                this.$root.bindTerminal(endpoint, name, this.terminal);
                console.debug("Terminal bound via parameter: " + name);
            } else if (this.name) {
                this.$root.unbindTerminal(this.name);
                this.$root.bindTerminal(this.endpoint, this.name, this.terminal);
                console.debug("Terminal bound: " + this.name);
            } else {
                console.debug("Terminal name not set");
            }
        },

        removeInput() {
            const textAfterCursorLength = this.terminalInputBuffer.length - this.cursorPosition;
            const spaces = " ".repeat(textAfterCursorLength);
            const backspaceCount = this.terminalInputBuffer.length;
            const backspaces = "\b \b".repeat(backspaceCount);
            this.cursorPosition = 0;
            this.terminal.write(spaces + backspaces);
            this.terminalInputBuffer = "";
        },

        clearCurrentLine() {
            // Move cursor to the beginning of the input and clear it
            const backspaces = "\b".repeat(this.cursorPosition);
            const spaces = " ".repeat(this.terminalInputBuffer.length);
            const moreBackspaces = "\b".repeat(this.terminalInputBuffer.length);
            this.terminal.write(backspaces + spaces + moreBackspaces);
        },

        mainTerminalConfig() {
            this.terminal.onKey(e => {
                // Optional: keep for debugging
                // console.debug("Encode: " + JSON.stringify(e.key));

                if (e.key === "\r") {
                    // Return if no input
                    if (this.terminalInputBuffer.length === 0) {
                        return;
                    }

                    const buffer = this.terminalInputBuffer;

                    // Remove the input from the terminal
                    this.removeInput();

                    this.$root.emitAgent(this.endpoint, "terminalInput", this.name, buffer + e.key, (err) => {
                        this.$root.toastError(err.msg);
                    });
                } else if (e.key === "\u007F") {      // Backspace
                    if (this.cursorPosition > 0) {
                        // Remove character to the left of cursor
                        const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition - 1);
                        const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                        this.terminalInputBuffer = beforeCursor + afterCursor;
                        this.cursorPosition--;

                        // Redraw the line
                        this.terminal.write("\b" + afterCursor + " \b".repeat(afterCursor.length + 1));
                    }
                } else if (e.key === "\u001B\u005B\u0033\u007E") { // Delete key
                    if (this.cursorPosition < this.terminalInputBuffer.length) {
                        // Remove character to the right of cursor
                        const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                        const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition + 1);
                        this.terminalInputBuffer = beforeCursor + afterCursor;

                        // Redraw the line from cursor position
                        this.terminal.write(afterCursor + " \b".repeat(afterCursor.length + 1));
                    }
                } else if (e.key === "\u001B\u005B\u0041" || e.key === "\u001B\u005B\u0042") {      // UP OR DOWN
                    // Do nothing
                } else if (e.key === "\u001B\u005B\u0043") {      // RIGHT
                    if (this.cursorPosition < this.terminalInputBuffer.length) {
                        this.terminal.write(this.terminalInputBuffer[this.cursorPosition]);
                        this.cursorPosition++;
                    }
                } else if (e.key === "\u001B\u005B\u0044") {      // LEFT
                    if (this.cursorPosition > 0) {
                        this.terminal.write("\b");
                        this.cursorPosition--;
                    }
                } else if (e.key === "\u0003") {      // Ctrl + C
                    console.debug("Ctrl + C");
                    this.$root.emitAgent(this.endpoint, "terminalInput", this.name, e.key);
                    this.removeInput();
                } else if (e.key === "\u0009" || e.key.startsWith("\u001B")) {      // TAB or other special keys
                    // Do nothing
                } else {
                    const textBeforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                    const textAfterCursor = this.terminalInputBuffer.slice(this.cursorPosition);
                    this.terminalInputBuffer = textBeforeCursor + e.key + textAfterCursor;
                    this.terminal.write(e.key + textAfterCursor + "\b".repeat(textAfterCursor.length));
                    this.cursorPosition++;
                }
            });
        },

        interactiveTerminalConfig() {
            // onData delivers typed keys and pasted text, so a paste reaches the PTY unchanged
            this.terminal.onData(data => {
                this.$root.emitAgent(this.endpoint, "terminalInput", this.name, data, (res) => {
                    if (!res.ok) {
                        this.$root.toastRes(res);
                    }
                });
            });
        },

        /**
         * Update the terminal size to fit the container size.
         *
         * If the terminalFitAddOn is not created, creates it, loads it and then fits the terminal to the appropriate size.
         * It then addes an event listener to the window object to listen for resize events and calls the fit method of the terminalFitAddOn.
         */
        updateTerminalSize() {
            // Подгонять пока нечего: панель просит размер сразу, как появилась вкладка,
            // а терминал ждет консольный шрифт. Открытие само закончится подгонкой,
            // а заготовленный здесь аддон остался бы привязанным в пустоту
            if (!this.terminal) {
                return;
            }

            if (!Object.hasOwn(this, "terminalFitAddOn")) {
                this.terminalFitAddOn = new FitAddon();
                this.terminal.loadAddon(this.terminalFitAddOn);
                window.addEventListener("resize", this.onResizeEvent);
            }

            this.terminalFitAddOn.fit();

            // The PTY was started with default dimensions, so the first fit has to be reported
            if (this.mode !== "displayOnly" && this.name) {
                this.$root.emitAgent(this.endpoint, "terminalResize", this.name, this.terminal.rows, this.terminal.cols);
            }
        },
        /**
         * Handles the resize event of the terminal component.
         */
        onResizeEvent() {
            this.terminalFitAddOn.fit();
            let rows = this.terminal.rows;
            let cols = this.terminal.cols;
            this.$root.emitAgent(this.endpoint, "terminalResize", this.name, rows, cols);
        },

        /**
         * Paste from the real clipboard, used by the explicit menu action.
         * A denied permission leaves a message in the menu instead of sending empty input.
         * @returns {void}
         */
        async pasteFromClipboard() {
            try {
                const text = await navigator.clipboard.readText();

                if (text) {
                    this.pasteText(text);
                    this.closeContextMenu();

                    // The menu button took the focus, give it back or the next key is lost
                    this.terminal.focus();
                } else {
                    this.contextMenuMessage = this.$t("clipboardEmpty");
                }
            } catch (error) {
                // The value is never logged, only the fact that reading failed
                this.contextMenuMessage = this.$t("clipboardDenied");
            }
        },

        /**
         * Handle a real paste event of the hidden xterm textarea
         * @param {ClipboardEvent} event Paste event
         * @returns {void}
         */
        handleNativePaste(event) {
            const text = event.clipboardData?.getData("text") ?? "";

            if (!text) {
                return;
            }

            event.preventDefault();
            this.pasteText(text);
        },

        closeContextMenu() {
            this.contextMenuVisible = false;
            this.contextMenuMessage = "";
        },

        /**
         * Paste text into the terminal based on current mode
         */
        pasteText(text) {
            if (this.mode === "mainTerminal") {
                // The limited console edits a single line, so only the first line is taken.
                // Otherwise the echo and the buffer drift apart and one Enter would run
                // every pasted line at once.
                const normalised = text.replace(/\r\n/g, "\n");
                const firstLine = normalised.split("\n")[0] ?? "";

                if (firstLine !== normalised) {
                    this.$root.toastError(this.$t("multilinePasteTruncated"));
                }

                text = firstLine;
            }

            if (this.mode === "mainTerminal") {
                // For main terminal, insert text at current cursor position
                const beforeCursor = this.terminalInputBuffer.slice(0, this.cursorPosition);
                const afterCursor = this.terminalInputBuffer.slice(this.cursorPosition);

                // Update the buffer with inserted text
                this.terminalInputBuffer = beforeCursor + text + afterCursor;

                // Clear the current line and rewrite it
                this.clearCurrentLine();
                this.terminal.write(this.terminalInputBuffer);

                // Move cursor to the correct position (after the pasted text)
                this.cursorPosition += text.length;
                const backspaces = "\b".repeat(afterCursor.length);
                this.terminal.write(backspaces);

            } else if (this.mode === "interactive") {
                // terminal.paste() keeps the text exactly as it is, including newlines
                this.terminal.paste(text);
            }
        },

        /**
         * Handle right-click context menu for paste operation
         */
        handleContextMenu(event) {
            // Only modes that accept input get a menu, otherwise the browser menu stays
            if (this.mode !== "mainTerminal" && this.mode !== "interactive") {
                return;
            }

            event.preventDefault();

            this.contextMenuMessage = "";
            this.contextMenuPosition = { x: event.clientX,
                y: event.clientY };
            this.contextMenuVisible = true;
        },

        /**
         * Handle text selection in terminal - copy to clipboard
         */
        handleSelection() {
            const selectedText = this.terminal.getSelection();
            if (selectedText && selectedText.length > 0) {
                this.copyToClipboard(selectedText);
            }
        },

        /**
         * Copy text to clipboard
         */
        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                // The selection itself is never logged
            } catch (error) {
                console.error("Failed to copy to clipboard:", error);
            }
        },
    }
};
</script>

<style scoped lang="scss">
// Консольная поверхность без рамки и радиуса: их дает панель вокруг терминала,
// поэтому один и тот же терминал одинаково выглядит на странице и во вкладке
.terminal-box {
    position: relative;
    height: 100%;
    overflow: hidden;
    background-color: var(--surface-console);

    // Поле ввода у xterm скрытое и размером в пиксель, поэтому кольцо фокуса
    // рисует коробка вокруг него: без этого приход в консоль с клавиатуры
    // ничем не отмечался, а из вывода еще и стрелками прокручивают.
    // Кольцо - слой поверх, а не `outline`: холсты xterm лежат выше контура
    // и закрывали его целиком, даже шестипиксельный
    &:focus-within::after {
        content: "";
        position: absolute;
        inset: 0;
        z-index: var(--layer-sticky);
        border: 2px solid var(--accent-text);
        pointer-events: none;
    }
}

.main-terminal {
    height: 100%;
}
</style>

<style lang="scss">
// Консоль рисует xterm своей темной темой, поэтому поверхность берется токеном,
// а не чистым черным: в светлой теме черный прямоугольник читался как дырка
.terminal {
    background-color: var(--surface-console) !important;
    height: 100%;
}

// Свою подложку xterm красит чистым черным прямо в xterm.css, и она видна по
// краям холста и под полосой прокрутки: поверхность задается токеном
.terminal .xterm-viewport {
    background-color: var(--surface-console) !important;
}
</style>
