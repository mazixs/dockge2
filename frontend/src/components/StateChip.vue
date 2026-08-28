<template>
    <span class="state-chip" :class="[ `state-${state}`, { 'fixed-width': fixedWidth } ]" :title="title">
        <!-- Точка несёт цвет, слово рядом - смысл: один цвет смысл не несёт -->
        <span class="dot" aria-hidden="true"></span>
        <font-awesome-icon v-if="attention" icon="triangle-exclamation" class="warn-icon" />
        <span class="label">{{ label }}</span>
    </span>
</template>

<script>
/**
 * Чип состояния - единственный вид, которым в интерфейсе показывается состояние.
 * Стек, сервис и отдельный контейнер обязаны выглядеть одинаково, поэтому вид
 * живёт здесь, а не повторяется в каждом экране.
 */
export default {
    props: {
        /** Имя состояния системы: running, attention, stopped, failed, unknown */
        state: {
            type: String,
            default: "unknown",
        },
        /** Слово рядом с точкой; без него чип показывал бы смысл одним цветом */
        label: {
            type: String,
            required: true,
        },
        /** Требует внимания: к точке добавляется значок, чтобы причина читалась и без цвета */
        attention: {
            type: Boolean,
            default: false,
        },
        /** Ровная ширина: в списке имена стеков должны начинаться на одной вертикали */
        fixedWidth: {
            type: Boolean,
            default: false,
        },
        /** Подсказка с подробностями; текст обязан быть доступен и без неё */
        title: {
            type: String,
            default: "",
        },
    },
};
</script>

<style lang="scss" scoped>
.state-chip {
    // Цвет состояния берётся один раз, дальше только через эту переменную:
    // так тема меняет чип сама, без правил внутри body.dark.
    --chip-state: var(--state-unknown);

    display: inline-flex;
    align-items: center;
    gap: var(--gap-xs);
    padding: 2px var(--gap-sm);
    border-radius: var(--radius-pill);
    font-size: var(--text-sm);
    line-height: 1.4;
    color: var(--text-strong);
    background-color: color-mix(in srgb, var(--chip-state) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--chip-state) 40%, transparent);
    white-space: nowrap;
}

.dot {
    width: 8px;
    height: 8px;
    border-radius: var(--radius-pill);
    background-color: var(--chip-state);
    flex: none;
}

.warn-icon {
    color: var(--chip-state);
}

.state-running {
    --chip-state: var(--state-running);
}

.state-attention {
    --chip-state: var(--state-attention);
}

.state-stopped {
    --chip-state: var(--state-stopped);
}

.state-failed {
    --chip-state: var(--state-failed);
}

.state-unknown {
    --chip-state: var(--state-unknown);
}

// Ширина выровнена по самой длинной подписи со значком; текст не обрезается,
// потому что обрезка молча теряет смысл слова.
.fixed-width {
    min-width: 96px;
}
</style>
