<template>
    <!-- Общий .env - та же панель, что файл стека: имя в шапке, действие рядом
         с именем, текст внутри, обещание сохранности под линией -->
    <form v-if="settingsLoaded" class="panel" @submit.prevent="saveGeneral">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="file" />{{ $t("GlobalEnv") }}</h2>
            <button class="btn btn-sm btn-primary" type="submit">
                <font-awesome-icon icon="save" />{{ $t("Save") }}
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
                :hasFocus="editorFocus"
                @change="onChange"
            />
        </div>

        <p class="panel-foot"><font-awesome-icon icon="info-circle" />{{ $t("globalEnvNote") }}</p>
    </form>
</template>

<script>
import CodeMirror from "vue-codemirror6";
import { python } from "@codemirror/lang-python"; // good enough for .env key=value highlighting
import { oneDark as editorTheme } from "@codemirror/theme-one-dark";
import { lineNumbers, EditorView } from "@codemirror/view";
import { ref } from "vue";
import InterfaceIcon from "../InterfaceIcon.vue";

export default {
    name: "GlobalEnv",
    components: {
        CodeMirror,
        InterfaceIcon,
    },

    setup() {
        const editorFocus = ref(false);

        const focusEffectHandler = (state, focusing) => {
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
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
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
};
</script>
