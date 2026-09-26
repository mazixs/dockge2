<template>
    <!-- Пустой экран - приглашение к действию: что здесь будет, почему сейчас пусто
         и что нажать. Без картинок: объясняет текст, а не иллюстрация -->
    <div class="empty-state">
        <h2 class="title">{{ title }}</h2>
        <p v-if="hint" class="hint">{{ hint }}</p>

        <div v-if="$slots.default" class="action">
            <slot />
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
    props: {
        /** Что здесь будет, когда появится: короткое имя пустоты */
        title: {
            type: String,
            required: true,
        },
        /** Почему сейчас пусто и что сделать - одна строка */
        hint: {
            type: String,
            default: "",
        },
    },
});
</script>

<style lang="scss" scoped>
.empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--gap-sm);
    padding: var(--gap-lg);
    text-align: center;
}

.title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-strong);
    color: var(--text-strong);
}

// Мера строки: объяснение читается в один-два ряда, а не поперек всего экрана
.hint {
    margin: 0;
    max-width: 52ch;
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.action {
    margin-top: var(--gap-xs);
}

// Действие приходит слотом, но требования к нему одни и те же: своя цель нажатия
// и видимый фокус, иначе с клавиатуры пустой экран не пройти
.action :deep(button),
.action :deep(a) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--gap-xs);
    min-height: var(--control-height);
    padding: 0 var(--gap-md);
    border: 1px solid var(--line-control);
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-strong);
    font-size: var(--text-base);
    text-decoration: none;
    cursor: pointer;

    &:hover {
        background-color: var(--surface-raised);
    }

    &:focus-visible {
        outline: var(--focus-ring);
        outline-offset: var(--focus-offset);
    }
}

// Главное действие экрана одно, и оно акцентное. Наведение смешивает акцент с
// цветом текста темы, поэтому обе темы темнеют или светлеют в свою сторону
.action :deep(.primary) {
    border-color: var(--accent);
    background-color: var(--accent);
    color: var(--text-on-accent);

    &:hover {
        background-color: color-mix(in srgb, var(--accent) 85%, var(--text-strong));
        color: var(--text-on-accent);
    }
}
</style>
