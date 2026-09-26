<template>
    <!-- Внешний вид - одна панель: язык и тема меняются сразу, поэтому кнопки
         сохранения у раздела нет -->
    <section class="panel">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="sliders" />{{ $t("appearance") }}</h2>
        </div>

        <div class="panel-body form-stack">
            <div class="field">
                <label for="language" class="form-label">{{ $t("language") }}</label>
                <select id="language" v-model="$root.language" class="form-select">
                    <option
                        v-for="language in availableLanguages"
                        :key="language.code"
                        :value="language.code"
                    >
                        {{ language.name }}
                    </option>
                </select>
            </div>

            <div class="field">
                <span class="form-label">{{ $t("theme") }}</span>
                <ThemePicker />
                <p class="form-text">{{ $t("familiarThemeHint") }}</p>
            </div>
        </div>
    </section>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import ThemePicker from "../ThemePicker.vue";
import InterfaceIcon from "../InterfaceIcon.vue";
import { availableLanguages } from "../../i18n";

export default defineComponent({
    components: { ThemePicker,
        InterfaceIcon },
    computed: {
        /**
         * Languages offered in the selector
         * @returns Language code and display name pairs
         */
        availableLanguages() : Array<{ code : string, name : string }> {
            return availableLanguages();
        },
    },
});
</script>

<style lang="scss" scoped>
// В форме выбор темы стоит рядом с выбором языка и занимает ту же ширину:
// два одинаковых контрола разной ширины читались как разные вещи
.theme-picker :deep(select) {
    width: 100%;
}
</style>
