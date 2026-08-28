<template>
    <span class="state-chip" :class="[ `state-${state}`, { 'fixed-width': fixedWidth, compact, 'dot-only': dotOnly } ]" :title="chipTitle">
        <!-- Точка несёт цвет, слово рядом - смысл: один цвет смысл не несёт.
             В строке списка слово прячется от глаз, но не от чтения с экрана:
             там же, в строке, состояние названо словами в колонке доступности -->
        <span class="dot" aria-hidden="true"></span>
        <font-awesome-icon v-if="attention && !dotOnly" icon="triangle-exclamation" class="warn-icon" />
        <span class="label" :class="{ 'visually-hidden': dotOnly }">{{ label }}</span>
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
        /**
         * Тихий вид для строки списка: точка и слово мелким, без рамки и заливки.
         * Слово остаётся - цвет не имеет права быть единственным носителем смысла.
         */
        compact: {
            type: Boolean,
            default: false,
        },
        /**
         * Только точка: слово уходит в скрытый текст, потому что рядом в строке
         * состояние уже названо словами (доступность, полоса внимания)
         */
        dotOnly: {
            type: Boolean,
            default: false,
        },
        /** Подсказка с подробностями; текст обязан быть доступен и без неё */
        title: {
            type: String,
            default: "",
        },
    },
    computed: {
        /** В точечном виде подсказка обязана называть состояние словом */
        chipTitle() {
            if (!this.dotOnly) {
                return this.title;
            }

            return this.title ? `${this.label} · ${this.title}` : this.label;
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

// Точечный вид: имена стеков выравниваются по одной вертикали
.state-chip.dot-only {
    padding: 0;
    border: 0;
    background: none;
    min-width: 0;
    width: 14px;
    justify-content: flex-start;
}

// Тихий вид: в строке списка чип не должен спорить с именем стека
.state-chip.compact {
    padding: 0;
    border: 0;
    background: none;
    font-size: var(--text-xs);
    color: var(--text-muted);

    .dot {
        width: 6px;
        height: 6px;
    }

    &.fixed-width {
        min-width: 74px;
    }
}

// Ширина выровнена по самой длинной подписи со значком; текст не обрезается,
// потому что обрезка молча теряет смысл слова.
.fixed-width {
    min-width: 96px;
}
</style>
