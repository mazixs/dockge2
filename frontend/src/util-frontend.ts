import type { Text } from "@codemirror/state";
import { localeDirection, currentLocale } from "./i18n";

/**
 * Set the locale of the HTML page
 * @returns {void}
 */
export function setPageLocale() {
    const html = document.documentElement;
    html.setAttribute("lang", currentLocale() );
    html.setAttribute("dir", localeDirection() );
}

/**
 * What went wrong, in the words a screen can show.
 *
 * A `catch` gets whatever was thrown, which is not always an `Error`. Reading `.message`
 * off it shows "undefined" to the user exactly when something unexpected happened, so
 * the value is named here instead.
 * @param error Whatever was thrown
 * @returns The message of the error, or the value itself as text
 */
export function errorText(error : unknown) : string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * The document a code editor reported through `update:modelValue`.
 *
 * vue-codemirror6 emits the document as a string but types the value as an optional string or
 * CodeMirror `Text`, so it cannot be bound to a string field with `v-model` directly.
 * @param value What the editor emitted
 * @returns The document as text
 */
export function editorText(value? : string | Text) : string {
    return value === undefined ? "" : value.toString();
}
