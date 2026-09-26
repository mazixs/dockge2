<template>
    <!-- Общий .env - та же панель, что файл стека: имя в шапке, действие рядом
         с именем, текст внутри, обещание сохранности под линией -->
    <form v-if="settingsLoaded" class="panel" @submit.prevent="saveGeneral">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="file" />{{ $t("globalEnv") }}</h2>
            <button class="btn btn-sm btn-primary" type="submit">
                <font-awesome-icon icon="save" />{{ $t("save") }}
            </button>
        </div>

        <div class="editor-box">
            <code-mirror
                ref="editor"
                v-model="settings.globalENV"
                :extensions="extensionsEnv"
                minimal
                wrap
                dark
                tab
                @change="onChange"
            />
        </div>

        <p class="panel-foot"><font-awesome-icon icon="info-circle" />{{ $t("globalEnvNote") }}</p>
    </form>
</template>

<script lang="ts">
import CodeMirror from "vue-codemirror6";
import { python } from "@codemirror/lang-python"; // good enough for .env key=value highlighting
import { oneDark as editorTheme } from "@codemirror/theme-one-dark";
import { lineNumbers, EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { defineComponent, ref, type ComponentPublicInstance } from "vue";
import InterfaceIcon from "../InterfaceIcon.vue";

/** What the settings page keeps for the sections it shows */
interface SettingsPage {
    /** The server always sends the text of the shared env file, or a sample when there is none */
    settings : { globalENV : string, [key : string] : unknown };
    saveSettings(callback? : (res : unknown) => void, currentPassword? : string) : void;
    settingsLoaded : boolean;
}

/**
 * The settings page, three levels up: the router view and its transition sit in between
 * @param section This section
 * @returns The page that holds the settings
 */
function settingsPage(section : ComponentPublicInstance) : SettingsPage {
    const page = section.$parent?.$parent?.$parent;

    if (!page) {
        throw new Error("A settings section is shown outside the settings page");
    }

    return page as ComponentPublicInstance & SettingsPage;
}

export default defineComponent({
    name: "GlobalEnv",
    components: {
        CodeMirror,
        InterfaceIcon,
    },

    setup() {
        const editorFocus = ref(false);

        const focusEffectHandler = (state : EditorState, focusing : boolean) => {
            editorFocus.value = focusing;
            return null;
        };

        const extensionsEnv = [
            editorTheme,
            python(),
            lineNumbers(),
            EditorView.focusChangeEffect.of(focusEffectHandler),
        ];

        return { editorFocus,
            extensionsEnv };
    },

    computed: {
        settings() : SettingsPage["settings"] {
            return settingsPage(this).settings;
        },
        saveSettings() : SettingsPage["saveSettings"] {
            return settingsPage(this).saveSettings;
        },
        settingsLoaded() : boolean {
            return settingsPage(this).settingsLoaded;
        },
    },

    methods: {
        /** Save the settings */
        saveGeneral() {
            this.saveSettings();
        },

        onChange() {
            // hook for future live validation if desired
        },
    },
});
</script>
