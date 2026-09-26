<template>
    <!-- Общие настройки: одно поле и одна кнопка. Панель названа тем же словом,
         что пункт слева, поэтому после перехода не нужно искать, где ты -->
    <section class="panel">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="server" />{{ $t("general") }}</h2>
        </div>

        <form class="panel-body form-stack" autocomplete="off" @submit.prevent="saveGeneral">
            <div class="field">
                <label class="form-label" for="primaryBaseURL">{{ $t("primaryHostname") }}</label>

                <div class="input-group">
                    <input
                        id="primaryBaseURL"
                        v-model="settings.primaryHostname"
                        class="form-control"
                        :placeholder="$t(`currentHostname`)"
                    />
                    <button class="btn btn-normal" type="button" @click="autoGetPrimaryHostname">
                        {{ $t("autoGet") }}
                    </button>
                </div>

                <p class="form-text">{{ $t("primaryHostnameHint") }}</p>
            </div>

            <div class="actions">
                <button class="btn btn-primary" type="submit">{{ $t("save") }}</button>
            </div>
        </form>
    </section>
</template>

<script lang="ts">
import { defineComponent, type ComponentPublicInstance } from "vue";
import InterfaceIcon from "../InterfaceIcon.vue";
import type { GeneralSettings, SettingsPageApi } from "../../pages/Settings.vue";

/**
 * The settings page this section is rendered in: the router view and its transition
 * stand between them
 * @param parent Parent of the section
 * @returns The page
 */
function settingsPage(parent : ComponentPublicInstance | null) : SettingsPageApi {
    const page = parent?.$parent?.$parent;
    if (!page || !("settings" in page)) {
        throw new Error("A settings section is rendered outside the settings page");
    }
    return page as ComponentPublicInstance & SettingsPageApi;
}

export default defineComponent({
    components: {
        InterfaceIcon,
    },

    computed: {
        settings() : GeneralSettings {
            return settingsPage(this.$parent).settings;
        },
        saveSettings() : SettingsPageApi["saveSettings"] {
            return settingsPage(this.$parent).saveSettings;
        },
        settingsLoaded() : boolean {
            return settingsPage(this.$parent).settingsLoaded;
        },
    },

    methods: {
        /** Save the settings */
        saveGeneral() {
            this.saveSettings();
        },
        /** Get the base URL of the application */
        autoGetPrimaryHostname() {
            this.settings.primaryHostname = location.hostname;
        },
    },
});
</script>

