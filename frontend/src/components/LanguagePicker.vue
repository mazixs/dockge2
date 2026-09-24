<template>
    <!-- The compact twin of ThemePicker: the language can be changed before signing in,
         when a reset choice would otherwise leave the login form in a foreign language -->
    <label class="language-picker">
        <span class="visually-hidden">{{ $t("Language") }}</span>
        <select v-model="$root.language" class="form-select" :class="{ 'form-select-compact': compact }" :aria-label="$t('Language')">
            <option v-for="language in availableLanguages" :key="language.code" :value="language.code" :lang="language.code">
                {{ language.name }}
            </option>
        </select>
    </label>
</template>

<script>
import { availableLanguages } from "../i18n";

export default {
    props: {
        /** Compact look for a row of dense header controls */
        compact: {
            type: Boolean,
            default: false,
        },
    },
    computed: {
        /**
         * Languages offered in the selector
         * @returns {Array<object>} Language code and display name pairs
         */
        availableLanguages() {
            return availableLanguages();
        },
    },
};
</script>

<style lang="scss" scoped>
.language-picker {
    display: inline-flex;
    margin: 0;

    select {
        cursor: pointer;
    }
}
</style>
