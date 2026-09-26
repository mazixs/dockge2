<template>
    <!-- Источник - та же панель, что файл, журнал и терминал слева от него:
         шапка на одной линии с соседом, тело, подпись-обещание внизу -->
    <aside class="panel source-panel">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon :name="source?.kind === 'git' ? 'git' : 'server'" />{{ $t("familiarSource") }}</h2>
            <span class="panel-meta">{{ source?.kind === "git" ? "Git" : $t("sourceLocal") }}</span>
        </div>

        <div class="panel-body source-body">
            <template v-if="source?.kind === 'git'">
                <p class="repository">{{ repositoryName }}</p>
                <div class="git-version"><span><InterfaceIcon name="git" />{{ source.branch || '-' }}</span><code v-if="source.commit" :title="source.commit"><font-awesome-icon icon="code-commit" />{{ source.commit.slice(0, 7) }}</code></div>
                <div class="source-status" :class="{ changed: hasChanges, unknown: state === 'unreadable' || state === 'unchecked' }"><font-awesome-icon :icon="state === 'clean' ? 'circle-check' : 'circle-exclamation'" /><span>{{ stateText }}</span></div>
                <p v-if="source.changedFiles" class="source-note">{{ $t("familiarFilesChanged", [source.changedFiles]) }}</p>
                <!-- Давность проверки идет строкой, а не под раскрывашкой: "изменений
                     нет" без нее читается как "проверено сейчас" -->
                <p v-if="freshness" class="source-note">{{ freshness }}</p>

                <router-link v-if="showCompare" :to="gitUrl" class="btn btn-normal">{{ $t(hasChanges ? "familiarGitCompare" : "familiarGitCheck") }}</router-link>
            </template>
            <template v-else>
                <p class="source-note">{{ $t("familiarLocalSource") }}</p>
                <p v-if="directory" class="directory">{{ directory }}</p>
            </template>
            <router-link v-if="$root.canManageStacks && source?.kind !== 'git'" :to="filesUrl" class="btn btn-normal"><InterfaceIcon name="file" />{{ $t("openComposeFile") }}</router-link>
        </div>

        <p class="panel-foot kept"><ShieldCheck />{{ $t("familiarSourcePreserved") }}</p>
    </aside>
</template>
<script lang="ts">
import { defineComponent, type PropType } from "vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import ShieldCheck from "./ShieldCheck.vue";
import { formatDuration } from "../format";
import { STACK_GIT_STATE_KEY, stackSourceDiffers, stackSourceState, type StackSource, type StackSourceState } from "../../../common/stack-source";
export default defineComponent({
    components: { InterfaceIcon,
        ShieldCheck },
    props: {
        /** Происхождение каталога стека, null когда его не удалось прочитать */
        source: {
            type: Object as PropType<StackSource | null>,
            default: null },
        directory: { type: String,
            default: "" },
        filesUrl: { type: String,
            required: true },
        gitUrl: { type: String,
            default: "" },
        /** Страница уже зовет сравнить изменения полосой над вкладками */
        comparePromoted: { type: Boolean,
            default: false },
    },
    computed: {
        /** Состояние каталога тем же словом, которым его называет список стеков */
        state() : StackSourceState {
            return stackSourceState(this.source);
        },

        hasChanges() : boolean {
            return stackSourceDiffers(this.state);
        },

        /** Что с файлами: правки на сервере, коммиты в Git или ни того, ни другого */
        stateText() : string {
            if (this.state === "local") {
                return "";
            }

            return this.$t(STACK_GIT_STATE_KEY[this.state], this.source?.behind ?? 0);
        },

        /**
         * Когда в последний раз спрашивали origin. Без этой строки любое
         * "изменений нет" читается как "проверено сейчас", хотя проверка могла
         * быть неделю назад или не быть вовсе
         * @returns {string} Давность проверки, пустая строка если о ней уже сказано
         */
        freshness() : string {
            if (this.source?.checkedAt) {
                return this.$t("familiarGitCheckedAgo", [ formatDuration(Date.now() - this.source.checkedAt, this.$t) ]);
            }

            return this.state === "unchecked" ? "" : this.$t("familiarGitNeverChecked");
        },

        /**
         * Кнопка сравнения нужна панели, только если ее нет над вкладками:
         * два одинаковых призыва в полуметре друг от друга спорят за нажатие
         * @returns {boolean} Показывать ли кнопку
         */
        showCompare() : boolean {
            return Boolean(this.$root.canManageStacks && this.gitUrl && !(this.hasChanges && this.comparePromoted));
        },
        repositoryName() : string {
            return (this.source?.remote || this.$t("sourceGit")).replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "").replace(/\//g, " / ");
        },
    },
});
</script>
<style lang="scss" scoped>
// Источник стоит вверху своей колонки и не тянется вслед за консолью слева
.source-panel { align-self: start; }
.source-body { display: flex; flex-direction: column; gap: var(--gap-sm); }
.repository { margin: 0; font-weight: var(--weight-medium); font-size: var(--text-sm); overflow-wrap: anywhere; }
.git-version { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-md); padding-bottom: var(--gap-sm); border-bottom: 1px solid var(--line-hair); color: var(--text-muted); font-size: var(--text-sm); flex-wrap: wrap; }
.git-version > * { display: inline-flex; align-items: center; gap: var(--gap-xs); }
.git-version code { padding: 0; background: none; color: var(--text-muted); }
.source-note, .directory { margin: 0; color: var(--text-muted); font-size: var(--text-sm); line-height: var(--line-sm); overflow-wrap: anywhere; }
.directory { font-family: var(--font-mono); }
.source-status { display: flex; align-items: center; gap: var(--gap-sm); font-size: var(--text-sm); color: var(--state-running); }
.source-status.unknown { color: var(--text-muted); }
.source-status.changed { color: var(--state-attention); }
.source-body > .btn { display: flex; align-items: center; justify-content: center; gap: var(--gap-sm); width: 100%; margin-top: var(--gap-xs); font-size: var(--text-sm); }
</style>
