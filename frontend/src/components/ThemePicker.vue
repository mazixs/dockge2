<template>
    <!-- Выбор темы стоит и в форме настроек, и рядом с мелкими контролами шапки:
         это один и тот же контрол формы, компактный вид отличается только
         размером, а не видом -->
    <label class="theme-picker" :class="{ compact }">
        <span class="visually-hidden">{{ $t("Theme") }}</span>
        <select v-model="$root.userTheme" class="form-select" :aria-label="$t('Theme')">
            <option value="auto">{{ $t("familiarThemeSystem") }}</option>
            <option value="light">{{ $t("Light") }}</option>
            <option value="dark">{{ $t("Dark") }}</option>
        </select>
    </label>
</template>

<script>
export default {
    props: {
        /** Компактный вид: в шапке и на экране установки выбор стоит в ряду плотных контролов */
        compact: {
            type: Boolean,
            default: false,
        },
    },
};
</script>

<style lang="scss" scoped>
.theme-picker {
    display: inline-flex;
    margin: 0;

    select {
        cursor: pointer;
    }
}

.theme-picker.compact select {
    min-height: var(--control-height);
    max-width: 160px;
    padding: var(--gap-xs) var(--gap-sm);
    color: var(--text-muted);
    font-size: var(--text-sm);
}
</style>
