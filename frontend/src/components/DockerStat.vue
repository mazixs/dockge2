<template>
    <div class="stats-container">
        <div class="stats-title">
            {{ stat.Name }}
        </div>
        <div class="stats">
            <div class="stat">
                <div class="stat-label">
                    {{ $t('cpu') }}
                </div>
                <div>
                    {{ stat.CPUPerc }}
                </div>
            </div>
            <div class="stat">
                <div class="stat-label">
                    {{ $t('memory') }}
                </div>
                <div>
                    {{ stat.MemUsage }} ({{ stat.MemPerc }})
                </div>
            </div>
            <div class="stat">
                <div class="stat-label">
                    {{ $t('networkIO') }}
                </div>
                <div>
                    {{ stat.NetIO }}
                </div>
            </div>
            <div class="stat">
                <div class="stat-label">
                    {{ $t('blockIO') }}
                </div>
                <div>
                    {{ stat.BlockIO }}
                </div>
            </div>
        </div>
    </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";

/** One container of `docker stats --format json`, the fields the card shows */
export interface DockerStatRow {
    Name : string;
    CPUPerc : string;
    MemUsage : string;
    MemPerc : string;
    NetIO : string;
    BlockIO : string;
}

export default defineComponent({
    props: {
        stat: {
            type: Object as PropType<DockerStatRow>,
            required: true
        }
    },
});
</script>

<style lang="scss" scoped>
.stats-container {
    container-type: inline-size;
}

// Четыре меры в строку, пока строка помещается; в узкой колонке они
// становятся столбцом пар "мера: значение"
.stats {
    container-type: inline-size;
    display: flex;
    justify-content: space-between;
    gap: var(--gap-sm);
    margin-top: var(--gap-xs);
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    .stat {
        display: flex;
        flex-direction: column;
        gap: var(--gap-xs);
    }

    @container (width < 420px) {
        flex-direction: column;

        .stat {
            flex-direction: row;
            gap: var(--gap-xs);
        }

        .stat-label::after {
            content: ":";
        }
    }
}

.stat-label {
    font-weight: var(--weight-strong);
}

.stats-title {
    font-size: var(--text-base);
    color: var(--text-muted);
}
</style>
