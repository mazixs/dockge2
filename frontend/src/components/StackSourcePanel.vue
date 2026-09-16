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
                <div class="source-status" :class="{ changed: hasChanges, unknown: source.dirty === null }"><font-awesome-icon :icon="hasChanges || source.dirty === null ? 'circle-exclamation' : 'circle-check'" /><span>{{ $t(hasChanges ? "familiarHasChanges" : source.dirty === null ? "familiarGitNotChecked" : "familiarGitClean") }}</span></div>
                <p v-if="source.changedFiles" class="source-note">{{ $t("familiarFilesChanged", [source.changedFiles]) }}</p>

                <router-link v-if="showCompare" :to="gitUrl" class="btn btn-normal">{{ $t(hasChanges ? "familiarGitCompare" : "familiarGitCheck") }}</router-link>
                <details class="git-freshness"><summary>{{ $t("pagesGitFreshness") }}</summary><p v-if="source.behind > 0" class="source-note">{{ $t("sourceBehindShort", [source.behind]) }}</p><p class="source-note">{{ $t("familiarGitLocalState") }}</p></details>
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
<script>
import InterfaceIcon from "./InterfaceIcon.vue";
import ShieldCheck from "./ShieldCheck.vue";
export default {
    components: { InterfaceIcon,
        ShieldCheck },
    props: {
        source: { type: Object,
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
        hasChanges() {
            return this.source?.dirty || this.source?.behind > 0;
        },

        /**
         * Кнопка сравнения нужна панели, только если ее нет над вкладками:
         * два одинаковых призыва в полуметре друг от друга спорят за нажатие
         * @returns {boolean} Показывать ли кнопку
         */
        showCompare() {
            return Boolean(this.$root.canManageStacks && this.gitUrl && !(this.hasChanges && this.comparePromoted));
        },
        repositoryName() {
            return (this.source?.remote || this.$t("sourceGit")).replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "").replace(/\//g, " / ");
        },
    },
};
</script>
<style lang="scss" scoped>
// Источник стоит вверху своей колонки и не тянется вслед за консолью слева
.source-panel { align-self: start; }
.source-body { display: flex; flex-direction: column; gap: var(--gap-sm); }
.repository { margin: 0; font-weight: var(--weight-medium); font-size: var(--text-sm); overflow-wrap: anywhere; }
.git-version { display: flex; align-items: center; justify-content: space-between; gap: var(--gap-md); padding-bottom: var(--gap-sm); border-bottom: 1px solid var(--line-hair); color: var(--text-muted); font-size: var(--text-sm); flex-wrap: wrap; }
.git-version > * { display: inline-flex; align-items: center; gap: var(--gap-xs); }
.git-version code { padding: 0; background: none; color: var(--text-muted); }
.source-note, .directory { margin: 0; color: var(--text-muted); font-size: var(--text-xs); line-height: var(--line-xs); overflow-wrap: anywhere; }
.directory { font-family: var(--font-mono); }
.source-status { display: flex; align-items: center; gap: var(--gap-sm); font-size: var(--text-sm); color: var(--state-running); }
.source-status.unknown { color: var(--text-muted); }
.source-status.changed { color: var(--state-attention); }
.source-body > .btn { display: flex; align-items: center; justify-content: center; gap: var(--gap-sm); width: 100%; margin-top: var(--gap-xs); font-size: var(--text-sm); }
.git-freshness { font-size: var(--text-xs); }
.git-freshness summary { cursor: pointer; color: var(--text-muted); }
.git-freshness summary:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-offset); }
.git-freshness .source-note { margin-top: var(--gap-xs); }
</style>
