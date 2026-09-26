<template>
    <!-- Выбор темы стоит и в форме настроек, и рядом с мелкими контролами шапки:
         это один и тот же контрол формы, компактный вид отличается только
         размером, а не видом -->
    <label class="theme-picker">
        <span class="visually-hidden">{{ $t("theme") }}</span>
        <select v-model="$root.userTheme" class="form-select" :class="{ 'form-select-compact': compact }" :aria-label="$t('theme')">
            <option value="auto">{{ $t("familiarThemeSystem") }}</option>
            <option value="light">{{ $t("light") }}</option>
            <option value="dark">{{ $t("dark") }}</option>
        </select>
    </label>
</template>

<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
    props: {
        /** Компактный вид: в шапке и на экране установки выбор стоит в ряду плотных контролов */
        compact: {
            type: Boolean,
            default: false,
        },
    },
});
</script>

<style lang="scss" scoped>
.theme-picker {
    display: inline-flex;
    margin: 0;

    select {
        cursor: pointer;
    }
}
</style>
