<template>
    <!-- О программе: версия, ссылка на выпуски и выбор, проверять ли обновления.
         Логотип не занимает экран - он здесь подпись, а не герой страницы -->
    <section class="panel">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="box" />{{ $t("About") }}</h2>
        </div>

        <div class="panel-body about-body">
            <div class="brand">
                <span class="brand-tile" aria-hidden="true"><InterfaceIcon name="box" /></span>
                <div class="brand-text">
                    <p class="wordmark"><BrandMark /></p>
                    <p class="versions">{{ $t("Version") }} {{ $root.info.version }} · {{ $t("Frontend Version") }} {{ $root.frontendVersion }}</p>
                </div>
            </div>

            <p v-if="!$root.isFrontendBackendVersionMatched" class="alert alert-warning" role="alert">
                <font-awesome-icon icon="triangle-exclamation" />{{ $t("Frontend Version do not match backend version!") }}
            </p>

            <div class="field">
                <span class="form-label">{{ $t("aboutUpdates") }}</span>
                <label class="form-check">
                    <input v-model="settings.checkUpdate" class="form-check-input" type="checkbox" @change="saveSettings()" />
                    <span class="form-check-label">{{ $t("Show update if available") }}</span>
                </label>
                <label class="form-check">
                    <input v-model="settings.checkBeta" class="form-check-input" type="checkbox" :disabled="!settings.checkUpdate" @change="saveSettings()" />
                    <span class="form-check-label">{{ $t("Also check beta release") }}</span>
                </label>
            </div>
        </div>

        <p class="panel-foot">
            <font-awesome-icon icon="info-circle" />
            <a href="https://github.com/mazixs/dockge2/releases" target="_blank" rel="noopener">{{ $t("Check Update On GitHub") }}</a>
        </p>
    </section>
</template>

<script>
import BrandMark from "../BrandMark.vue";
import InterfaceIcon from "../InterfaceIcon.vue";

export default {
    components: { BrandMark,
        InterfaceIcon },
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
};
</script>

<style lang="scss" scoped>
.about-body {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}

.brand {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
}

// Знак продукта рисуется тем же контуром, что в шапке, а не файлом значка
// вкладки: у файла свой непрозрачный фон и своя зелень, и на панели он читался
// как чужая наклейка поверх темы
.brand-tile {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-card);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--text-title-sm);
}

.brand-text {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
}

.wordmark {
    margin: 0;
    font-size: var(--text-lg);
    line-height: var(--line-lg);
    font-weight: var(--weight-strong);
    color: var(--text-strong);
}

.versions {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-faint);
}

.alert {
    margin: 0;
}
</style>
