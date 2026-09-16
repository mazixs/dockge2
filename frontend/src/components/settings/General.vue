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
                        :placeholder="$t(`CurrentHostname`)"
                    />
                    <button class="btn btn-normal" type="button" @click="autoGetPrimaryHostname">
                        {{ $t("autoGet") }}
                    </button>
                </div>

                <p class="form-text">{{ $t("primaryHostnameHint") }}</p>
            </div>

            <div class="actions">
                <button class="btn btn-primary" type="submit">{{ $t("Save") }}</button>
            </div>
        </form>
    </section>
</template>

<script>

import InterfaceIcon from "../InterfaceIcon.vue";

export default {
    components: {
        InterfaceIcon,
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
        /** Get the base URL of the application */
        autoGetPrimaryHostname() {
            this.settings.primaryHostname = location.hostname;
        },
    },
};
</script>

