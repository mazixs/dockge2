<template>
    <div class="git-ui page changes-page" :aria-busy="loading || applying">
        <router-link class="back-link" :to="stackPath">← {{ $t("gitUiBackStack", [ stackName ]) }}</router-link>
        <div class="change-heading">
            <div>
                <p class="eyebrow">{{ stackName }} / {{ $t("gitUiUpdateFromGit") }}</p>
                <h1>{{ $t(review ? "gitUiReviewResult" : "gitUiWhatChanged") }}</h1>
                <p v-if="!result" class="subtitle">{{ $t(review ? "gitUiReviewDescription" : "gitUiChangesDescription") }}</p>
            </div>
            <span v-if="!result" class="state-label" :class="{ running: servicesRunning }">{{ servicesRunning ? $t("gitUiServicesRunning") : $t(statusLabel) }}</span>
        </div>
        <div v-if="failure" class="notice failure" role="alert">
            <p>{{ failure }}</p>
            <button v-if="!applying" class="btn btn-normal" type="button" @click="loadPreview">{{ $t("gitUiCheckAgain") }}</button>
        </div>
        <div v-if="loading" class="notice" role="status">{{ $t("gitUiFetching") }}</div>
        <section v-if="result" class="result-card" role="status">
            <h2>{{ $t(result.deployed ? "gitUiUpdateDeployed" : "gitUiUpdateSaved") }}</h2>
            <p v-if="result.deploymentError" class="notice failure">{{ $root.serverText(result.deploymentError, "gitUiDeploymentFailedSaved") }}</p>
            <p v-else>{{ $t(result.deployed ? "gitUiDeployComplete" : "gitUiUpdateSavedDescription") }}</p>
            <p v-if="hasLocalChoice">{{ $t("gitUiLocalRemains") }}</p>
            <router-link class="btn btn-primary" :to="stackPath">{{ $t("gitUiOpenStack") }}</router-link>
        </section>
        <template v-else-if="preview && !loading">
            <div class="change-context">
                <span>{{ preview.branch }}</span>
                <span>{{ $t(preview.currentCommit === preview.targetCommit ? "gitUiLocalChanges" : "gitUiRemoteUpdate") }}</span>
                <span><code :title="preview.currentCommit">{{ shortCommit(preview.currentCommit) }}</code><template v-if="preview.currentCommit !== preview.targetCommit"> → <code :title="preview.targetCommit">{{ shortCommit(preview.targetCommit) }}</code></template></span>
                <span>{{ $t("gitUiCheckedNow") }}</span>
            </div>
            <section v-if="preview.files.length === 0" class="result-card empty-result">
                <h2>{{ $t("gitUiNoChanges") }}</h2>
                <p>{{ $t("gitUiNoChangesDescription") }}</p>
                <button class="btn btn-normal" type="button" @click="loadPreview">{{ $t("gitUiCheckAgain") }}</button>
            </section>
            <template v-else-if="!review">
                <div class="change-counts"><span v-for="status in [ 'added', 'modified', 'deleted' ]" :key="status">{{ $t("gitUiFile_" + status) }}: {{ preview.files.filter(file => file.status === status).length }}</span></div>
                <div class="comparison-note">
                    <strong>{{ $t(ready ? "gitUiAllReady" : "gitUiChooseEveryFile") }}</strong>
                    <span>{{ $t("gitUiUnchangedUntilApply") }}</span>
                </div>
                <div class="diff-workspace">
                    <aside class="diff-files" :aria-label="$t('gitUiFiles')">
                        <div class="files-heading"><h2>{{ $t("gitUiFiles") }}</h2><span>{{ preview.files.length }}</span></div>
                        <button v-for="file in preview.files" :key="file.path" type="button" class="diff-file" :class="{ active: selectedPath === file.path }" :aria-current="selectedPath === file.path ? 'true' : undefined" @click="selectedPath = file.path">
                            <span><strong>{{ file.path }}</strong><small>{{ choiceLabel(file.path) }}</small></span>
                            <span class="choice-mark" :class="{ chosen: choices[file.path] }" aria-hidden="true">{{ choices[file.path] ? "✓" : "○" }}</span>
                        </button>
                        <p class="files-foot">{{ $t("gitUiUnchangedUntilApply") }}</p>
                    </aside>
                    <div v-if="selectedFile" class="diff-detail">
                        <div class="filebar"><strong>{{ selectedFile.path }}</strong><span>{{ $t("gitUiFile_" + selectedFile.status) }}</span></div>
                        <div v-if="selectedFile.redacted || selectedFile.binary" class="hidden-file notice">
                            {{ $t(selectedFile.redacted ? "gitUiRedactedFile" : "gitUiBinaryFile") }}
                        </div>
                        <div class="diff-columns">
                            <section class="server-side" :aria-label="$t('gitUiOnServer')">
                                <div class="diff-label"><strong>{{ $t("gitUiOnServer") }}</strong><span>{{ $t("gitUiYourVersion") }}</span></div>
                                <div class="code-scroll" tabindex="0" :aria-label="$t('gitUiOnServer') + ': ' + selectedFile.path">
                                    <p v-if="selectedFile.redacted || selectedFile.binary" class="empty-file">{{ $t("gitUiContentHidden") }}</p>
                                    <p v-else-if="selectedFile.serverText === null" class="empty-file">{{ $t("gitUiFileAbsent") }}</p>
                                    <pre v-else><code><span v-for="(line, index) in serverLines" :key="index" class="code-line" :class="{ changed: line.changed }"><span class="line-no" aria-hidden="true">{{ index + 1 }}</span><span class="line-sign" aria-hidden="true">{{ line.changed ? "-" : " " }}</span><span>{{ line.text || " " }}</span></span></code></pre>
                                </div>
                                <button class="btn btn-normal" :class="{ chosen: choices[selectedPath] === 'server' }" type="button" :aria-pressed="choices[selectedPath] === 'server'" @click="choose('server')">{{ choices[selectedPath] === "server" ? "✓ " : "" }}{{ $t("gitUiKeepServer") }}</button>
                            </section>
                            <section class="git-side" :aria-label="$t('gitUiFromGit')">
                                <div class="diff-label"><strong>{{ $t("gitUiFromGit") }}</strong><code>{{ shortCommit(preview.targetCommit) }}</code></div>
                                <div class="code-scroll" tabindex="0" :aria-label="$t('gitUiFromGit') + ': ' + selectedFile.path">
                                    <p v-if="selectedFile.redacted || selectedFile.binary" class="empty-file">{{ $t("gitUiContentHidden") }}</p>
                                    <p v-else-if="selectedFile.gitText === null" class="empty-file">{{ $t("gitUiFileAbsent") }}</p>
                                    <pre v-else><code><span v-for="(line, index) in gitLines" :key="index" class="code-line" :class="{ changed: line.changed }"><span class="line-no" aria-hidden="true">{{ index + 1 }}</span><span class="line-sign" aria-hidden="true">{{ line.changed ? "+" : " " }}</span><span>{{ line.text || " " }}</span></span></code></pre>
                                </div>
                                <button class="btn btn-normal" :class="{ chosen: choices[selectedPath] === 'git' }" type="button" :aria-pressed="choices[selectedPath] === 'git'" @click="choose('git')">{{ choices[selectedPath] === "git" ? "✓ " : "" }}{{ $t("gitUiTakeGit") }}</button>
                            </section>
                        </div>
                        <div v-if="!selectedFile.redacted && !selectedFile.binary" class="edit-result">
                            <button class="btn btn-normal" type="button" :aria-pressed="choices[selectedPath] === 'edited'" @click="editResult">{{ $t("gitUiEditResult") }}</button>
                            <template v-if="choices[selectedPath] === 'edited'">
                                <label for="git-result-editor">{{ $t("gitUiResultInMemory") }}</label>
                                <textarea id="git-result-editor" v-model="editedContents[selectedPath]" spellcheck="false" :aria-label="$t('gitUiEditResult') + ': ' + selectedPath"></textarea>
                                <p>{{ $t("gitUiEditedFileRule") }}</p>
                            </template>
                        </div>
                    </div>
                </div>
                <footer class="decision-footer">
                    <span aria-live="polite">✓ {{ $t("gitUiFilesReady", [ resolvedCount, preview.files.length ]) }}</span>
                    <div class="action-group">
                        <router-link class="btn btn-normal" :to="stackPath">{{ $t("gitUiCancel") }}</router-link>
                        <button class="btn btn-primary" type="button" :disabled="!ready" @click="review = true">{{ $t("gitUiReviewResult") }}</button>
                    </div>
                </footer>
            </template>
            <div v-else class="review-layout">
                <section class="review-card">
                    <h2>{{ $t("gitUiSelectedFiles") }}</h2>
                    <div class="review-rows">
                        <div v-for="file in preview.files" :key="file.path" class="review-row"><strong>{{ file.path }}</strong><span>{{ choiceLabel(file.path) }}</span><span aria-hidden="true">✓</span></div>
                    </div>
                    <div class="review-impact">
                        <h3>{{ $t("gitUiAfterApply") }}</h3>
                        <p>{{ $t("gitUiApplyDescription") }}</p>
                        <p>{{ $t("gitUiRestartImpact") }}</p>
                        <p>{{ $t("gitUiResultValidated") }}</p>
                        <p v-if="hasLocalChoice" class="local-remains">{{ $t("gitUiLocalRemains") }}</p>
                    </div>
                    <div v-if="applying" class="notice" role="status">{{ $t("gitUiApplying") }}</div>
                    <div class="review-actions">
                        <button class="btn btn-normal" type="button" :disabled="applying" @click="review = false">← {{ $t("gitUiBackComparison") }}</button>
                        <button class="btn btn-normal" type="button" :disabled="applying || !ready || Boolean(failure)" @click="apply(false)">{{ $t("saveWithoutStarting") }}</button>
                        <button class="btn btn-primary" type="button" :disabled="applying || !ready || Boolean(failure)" @click="apply(true)">{{ $t("gitUiApplyDeploy") }}</button>
                    </div>
                </section>
                <aside class="review-aside">
                    <h3>{{ $t("gitUiControlChanges") }}</h3>
                    <p>{{ $t("gitUiPreserveText") }}</p>
                    <p>{{ $t("gitUiPreviewExpiry") }}</p>
                </aside>
            </div>
        </template>
    </div>
</template>

<script>
// @ts-check
import { canApplyGitChoices, diffLineRows } from "../git-ui";
import { ATTENTION, CREATED_FILE, CREATED_STACK, EXITED, RUNNING, isStackFailed } from "../../../common/util-common";

/**
 * How long the acknowledgement of an apply is waited for.
 *
 * Writing the chosen files and deploying them takes as long as docker compose takes. The
 * wait is long, but it ends: while it lasts the page refuses to be left, so an answer
 * that never arrived used to keep the person on a page that could do nothing.
 */
const APPLY_REQUEST_TIMEOUT_MS = 15 * 60_000;

export default {
    /**
     * Hold the person on the page while the files are being applied
     * @this {{ applying : boolean }}
     * @returns {boolean} Whether leaving is allowed
     */
    beforeRouteLeave() {
        return !this.applying;
    },
    data() {
        return {
            /** @type {import("../../../common/types/stack-git").GitUpdatePreview | null} */
            preview: null,
            previewEndpoint: "",
            previewStackName: "",
            selectedPath: "",
            /** @type {Record<string, import("../../../common/types/stack-git").GitFileChoice>} */
            choices: {},
            /** Черновик результата по каждому файлу @type {Record<string, string>} */
            editedContents: {},
            loading: false,
            applying: false,
            failure: "",
            review: false,
            /** @type {import("../../../common/types/stack-git").GitSaveResult | null} */
            result: null,
            requestVersion: 0,
        };
    },
    computed: {
        stackName() {
            // Параметр маршрута может прийти списком: страница работает с одним стеком
            return String(this.$route.params.stackName ?? "");
        },
        endpoint() {
            return String(this.$route.params.endpoint || "");
        },
        stackPath() {
            return `/stack/${encodeURIComponent(this.stackName)}${this.endpoint ? `/${encodeURIComponent(this.endpoint)}` : ""}`;
        },
        currentStack() {
            return this.$root.completeStackList[this.stackName + "_" + this.endpoint];
        },
        statusLabel() {
            /** @type {Record<number, string>} */
            const labels = { [CREATED_FILE]: "pagesNotDeployed",
                [CREATED_STACK]: "pagesStopped",
                [RUNNING]: "pagesRunning",
                [ATTENTION]: "pagesAttention" };
            const status = this.currentStack?.status;

            if (this.$root.agentStatusList[this.endpoint] !== "online" || status === undefined) {
                return "pagesUnknown";
            }
            if (status === EXITED) {
                return isStackFailed(status, this.currentStack?.issues) ? "pagesFailed" : "pagesStopped";
            }
            return labels[status] || "pagesUnknown";
        },
        servicesRunning() {
            return this.statusLabel === "pagesRunning";
        },
        selectedFile() {
            return this.preview?.files.find(file => file.path === this.selectedPath);
        },
        serverLines() {
            return diffLineRows(this.selectedFile?.serverText ?? null, this.selectedFile?.gitText ?? null);
        },
        gitLines() {
            return diffLineRows(this.selectedFile?.gitText ?? null, this.selectedFile?.serverText ?? null);
        },
        resolvedCount() {
            return this.preview?.files.filter(file => Object.hasOwn(this.choices, file.path)).length || 0;
        },
        ready() {
            return this.$root.canManageStacks && canApplyGitChoices(this.preview?.files || [], this.choices, this.editedContents);
        },
        hasLocalChoice() {
            return Object.values(this.choices).some(choice => choice === "server" || choice === "edited");
        },
    },
    watch: {
        "$root.socketIO.connected"(connected) {
            if (!connected && this.applying) {
                this.applying = false;
                this.failure = this.$t("gitUiResultUnknown");
            }
        },
        "$route.fullPath"() {
            // Смена стека на том же маршруте оставляла ожидание прежнего стека: его
            // ответ применился бы к новому экрану, а чтение изменений не начиналось
            this.forgetRequest();
            this.loadPreview();
        },
    },
    mounted() {
        this.loadPreview();
    },
    unmounted() {
        this.forgetRequest();
    },
    methods: {
        /**
         * Stop waiting for whatever was asked: the page this asked for is gone.
         *
         * The wait is ended here, not the work on the server: an apply that was sent
         * carries on, and the state it leaves is read again by the next preview.
         * @returns {void}
         */
        forgetRequest() {
            if (this.preview && !this.applying) {
                this.$root.emitAgentRequest(this.previewEndpoint, "gitDiscardPreview", [ this.previewStackName, this.preview.id ]);
            }
            this.preview = null;
            this.requestVersion++;
            this.loading = false;
            this.applying = false;
        },
        /**
         * Show the commit identifier provided by the server.
         * @param {string} [commit] Commit the preview named
         * @returns {string} Its short form
         */
        shortCommit(commit) {
            return commit?.slice(0, 7) || "?";
        },
        /**
         * Read the exact per-file decision, never an inherited object property.
         * @param {string} path File the decision is about
         * @returns {string} What the decision says
         */
        choiceLabel(path) {
            if (!Object.hasOwn(this.choices, path)) {
                return this.$t("gitUiNeedsChoice");
            }
            if (this.choices[path] === "edited") {
                return this.$t("gitUiEditedResult");
            }
            return this.$t(this.choices[path] === "server" ? "gitUiKeepServer" : "gitUiTakeGit");
        },
        /**
         * Record an explicit selection while preserving all other file decisions.
         * @param {"server" | "git" | "edited"} choice Which version wins for this file
         * @returns {void}
         */
        choose(choice) {
            this.choices = { ...this.choices,
                [this.selectedPath]: choice };
        },
        /** Start with exact source bytes; retain the in-memory draft across choices. */
        editResult() {
            const file = this.selectedFile;

            if (!file) {
                return;
            }

            if (!Object.hasOwn(this.editedContents, this.selectedPath)) {
                this.editedContents = { ...this.editedContents,
                    [this.selectedPath]: (this.choices[this.selectedPath] === "git" ? file.gitText : file.serverText) ?? file.gitText ?? file.serverText ?? "" };
            }
            this.choose("edited");
        },
        /** Fetch remote changes and reject responses belonging to an earlier route. */
        loadPreview() {
            if (this.applying || !this.$root.canManageStacks) {
                return;
            }
            if (!this.$root.socketIO.connected || this.$root.agentStatusList[this.endpoint] !== "online") {
                this.failure = this.$t("gitUiRequestFailed");
                return;
            }
            const version = ++this.requestVersion;
            this.loading = true;
            this.failure = "";
            if (this.preview) {
                this.$root.emitAgentRequest(this.previewEndpoint, "gitDiscardPreview", [ this.previewStackName, this.preview.id ]);
            }
            this.preview = null;
            this.choices = {};
            this.editedContents = {};
            this.review = false;
            this.result = null;
            const endpoint = this.endpoint;
            const stackName = this.stackName;
            this.$root.emitAgentRequest(endpoint, "gitPreviewUpdate", [ stackName ], { timeoutMs: 90_000 }).then((res) => {
                if (version !== this.requestVersion) {
                    if (res?.ok) {
                        this.$root.emitAgentRequest(endpoint, "gitDiscardPreview", [ stackName, res.preview.id ]);
                    }
                    return;
                }
                this.loading = false;
                if (!res?.ok) {
                    this.failure = res?.unknown ? this.$t("gitUiPreviewTimeout") : this.$root.serverText(res?.msg, "gitUiRequestFailed");
                    return;
                }
                this.preview = res.preview;
                this.previewEndpoint = endpoint;
                this.previewStackName = stackName;
                this.selectedPath = res.preview.files[0]?.path || "";
            });
        },
        /**
         * Apply the reviewed snapshot; the server revalidates disk state before writing.
         * @param {boolean} deploy Whether the stack is started once the files are written
         * @returns {void}
         */
        apply(deploy) {
            if (!this.ready || this.applying || this.failure || !this.preview) {
                return;
            }
            this.applying = true;
            const version = ++this.requestVersion;
            this.$root.emitAgentRequest(this.endpoint, "gitApplyUpdate", [{
                stackName: this.stackName,
                previewId: this.preview.id,
                choices: this.choices,
                editedContents: Object.fromEntries(Object.entries(this.editedContents).filter(([ path ]) => this.choices[path] === "edited")),
                deploy,
            }], { timeoutMs: APPLY_REQUEST_TIMEOUT_MS }).then((res) => {
                if (version !== this.requestVersion) {
                    return;
                }
                this.applying = false;

                if (!res?.ok) {
                    // Подтверждения не было: файлы могли быть записаны, а стек - переподнят.
                    // Страница не повторяет применение, а предлагает перечитать изменения
                    this.failure = res?.unknown ? this.$t("gitUiResultUnknown") : this.$root.serverText(res?.msg, "gitUiRequestFailed");
                    return;
                }
                this.failure = "";
                this.result = res;
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/git-pages";

// Разбор изменений занимает всю рабочую область: две колонки кода рядом
// читаются только на широком экране
.changes-page {
    max-width: 1400px;
}

.change-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--gap-md);

    h1 {
        margin: 0;
    }
}

// Откуда пришел пользователь: имя стека и действие над ним
.eyebrow {
    margin: 0 0 var(--gap-xs);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.subtitle {
    margin: var(--gap-xs) 0 0;
    max-width: 62ch;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.state-label {
    flex-shrink: 0;
    padding: var(--gap-xs) var(--gap-sm);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-chip);
    background-color: var(--surface-raised);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.state-label.running {
    color: var(--state-running);
}

// Строка происхождения: ветка, вид изменения и версии - между двумя линиями
.change-context {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-md) var(--gap-lg);
    padding: var(--gap-sm) 0;
    border-top: 1px solid var(--line-hair);
    border-bottom: 1px solid var(--line-hair);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.change-context > span:last-child {
    margin-left: auto;
}

.change-context code {
    padding: 0;
    background: none;
    color: var(--text-strong);
    font-family: var(--font-mono);
    font-size: var(--text-code);
}

.change-counts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-md);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

// Что требуется от пользователя прямо сейчас
.comparison-note {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--gap-sm) var(--gap-md);
    color: var(--state-changes);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    span {
        color: var(--text-muted);
        font-size: var(--text-sm);
        line-height: var(--line-sm);
    }
}

// Сравнение - одна панель: слева файлы, справа две версии одного файла
.diff-workspace {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);
    background-color: var(--surface-panel);
    overflow: hidden;
}

.diff-files {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
    min-width: 0;
    padding: var(--gap-sm);
    border-right: 1px solid var(--line-hair);
}

.files-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-sm);
    padding: var(--gap-xs) var(--gap-sm);

    h2 {
        margin: 0;
        font-size: var(--text-sm);
        line-height: var(--line-sm);
    }

    > span {
        color: var(--text-faint);
        font-size: var(--text-sm);
    }
}

.diff-file {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    min-width: 0;
    padding: var(--gap-sm);
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-muted);
    text-align: left;
    transition: background-color var(--motion-fast) var(--motion-ease);

    &:hover {
        background-color: var(--surface-raised);
    }

    > span:first-child {
        flex: 1;
        min-width: 0;
    }

    strong {
        display: block;
        font-size: var(--text-sm);
        line-height: var(--line-sm);
        overflow-wrap: anywhere;
    }

    small {
        display: block;
        margin-top: 2px;
        color: var(--text-faint);
        font-size: var(--text-sm);
        line-height: var(--line-sm);
    }
}

.diff-file.active {
    background-color: var(--surface-raised);
    color: var(--text-strong);
}

// Знак выбора: пока сторона не выбрана, он цвета изменений, после - зеленый
.choice-mark {
    color: var(--state-changes);
}

.choice-mark.chosen {
    color: var(--state-running);
}

.files-foot {
    margin: auto 0 0;
    padding: var(--gap-lg) var(--gap-sm) var(--gap-xs);
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

.diff-detail {
    min-width: 0;
    background-color: var(--surface-base);
}

// Шапка выбранного файла повторяет шапку панели: имя слева, вид изменения справа
.filebar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-md);
    min-height: calc(var(--control-height) + var(--gap-sm));
    padding: var(--gap-xs) var(--gap-md);
    border-bottom: 1px solid var(--line-hair);
    background-color: var(--surface-panel);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    overflow-wrap: anywhere;

    span {
        color: var(--text-muted);
        font-size: var(--text-sm);
        line-height: var(--line-sm);
    }
}

.hidden-file {
    margin: var(--gap-md);
}

.diff-columns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
}

.diff-columns > section {
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding-bottom: var(--gap-md);
}

.diff-columns > section + section {
    border-left: 1px solid var(--line-hair);
}

.diff-label {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    padding: var(--gap-sm) var(--gap-md);
    border-bottom: 1px solid var(--line-hair);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    > span, code {
        margin-left: auto;
        color: var(--text-muted);
        font-size: var(--text-sm);
    }

    code {
        padding: 0;
        background: none;
        font-family: var(--font-mono);
    }
}

.code-scroll {
    max-height: 350px;
    min-height: 70px;
    margin-bottom: var(--gap-md);
    overflow: auto;
}

pre {
    margin: 0;
    padding: var(--gap-sm) 0;
}

pre code {
    display: block;
    color: var(--text-strong);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--line-code);
}

.code-line {
    display: flex;
    min-width: 0;
    padding-right: var(--gap-sm);
    border-left: 2px solid transparent;
    white-space: pre-wrap;

    > span:last-child {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
    }
}

.line-no {
    flex: 0 0 35px;
    padding-right: var(--gap-sm);
    color: var(--text-faint);
    text-align: right;
    user-select: none;
}

.line-sign {
    flex: 0 0 13px;
    user-select: none;
}

// Сторона сервера теряет строки, сторона гита их приносит: цвет тот же, что
// у состояний стека, поэтому значение читается без легенды
.server-side .changed {
    border-left-color: var(--state-failed);
    background-color: color-mix(in srgb, var(--state-failed) 10%, transparent);
}

.git-side .changed {
    border-left-color: var(--state-running);
    background-color: color-mix(in srgb, var(--state-running) 10%, transparent);
}

.diff-columns .btn {
    margin: auto var(--gap-md) 0;
}

.empty-file {
    margin: 0;
    padding: var(--gap-lg) var(--gap-md);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

// Правка итога живет под сравнением, а не вместо него
.edit-result {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    padding: var(--gap-md);
    border-top: 1px solid var(--line-hair);

    .btn {
        align-self: flex-start;
    }

    textarea {
        width: 100%;
        min-height: 180px;
        max-height: 500px;
        padding: var(--gap-sm);
        border: 1px solid var(--line-hair);
        border-radius: var(--radius-control);
        background-color: var(--surface-panel);
        color: var(--text-strong);
        font-family: var(--font-mono);
        font-size: var(--text-code);
        line-height: var(--line-code);
        resize: vertical;
    }

    label, p {
        margin: 0;
        color: var(--text-muted);
        font-size: var(--text-sm);
        line-height: var(--line-sm);
    }
}

// Итог решения: сколько файлов разобрано и что делать дальше
.decision-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--gap-md);
    padding-top: var(--gap-md);
    border-top: 1px solid var(--line-hair);

    > span {
        color: var(--text-muted);
        font-size: var(--text-sm);
        line-height: var(--line-sm);
    }
}

.review-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: var(--gap-2xl);
}

.review-card {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
    padding: var(--gap-lg);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-panel);
    background-color: var(--surface-panel);

    h2 {
        margin: 0;
    }
}

.review-rows {
    display: flex;
    flex-direction: column;
}

.review-row {
    display: flex;
    align-items: center;
    gap: var(--gap-sm) var(--gap-md);
    padding: var(--gap-sm) 0;
    border-bottom: 1px solid var(--line-hair);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    strong {
        min-width: 0;
        overflow-wrap: anywhere;
    }

    > span:first-of-type {
        margin-left: auto;
        color: var(--text-muted);
        font-size: var(--text-sm);
    }

    > span:last-of-type {
        color: var(--state-running);
    }
}

// Что произойдет после применения: список последствий, а не предупреждение
.review-impact {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    h3 {
        margin: 0;
        color: var(--text-strong);
    }

    p {
        margin: 0;
    }

    .local-remains {
        color: var(--state-changes);
    }
}

.review-actions {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--gap-sm);
}

.review-aside {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    h3 {
        margin: 0;
        color: var(--text-strong);
    }

    p {
        margin: 0;
    }
}

@media (max-width: 1100px) {
    .diff-workspace {
        grid-template-columns: minmax(0, 1fr);
    }

    .diff-files {
        flex-direction: row;
        border-right: 0;
        border-bottom: 1px solid var(--line-hair);
        overflow: auto;
    }

    .files-heading, .files-foot {
        display: none;
    }

    .diff-file {
        flex: 1;
        min-width: 155px;
    }

    .review-layout {
        grid-template-columns: minmax(0, 1fr);
        gap: var(--gap-lg);
    }
}

@media (max-width: 720px) {
    .change-heading {
        flex-direction: column;
    }

    .change-context > span:last-child {
        margin-left: 0;
    }

    .diff-columns {
        grid-template-columns: minmax(0, 1fr);
    }

    .diff-columns > section + section {
        border-left: 0;
        border-top: 1px solid var(--line-hair);
    }

    .code-scroll {
        max-height: 255px;
    }

    .decision-footer .action-group,
    .decision-footer .btn {
        flex: 1;
    }

    .review-row {
        flex-wrap: wrap;
    }

    .review-row > span:first-of-type {
        margin-left: 0;
    }

    .review-actions {
        flex-direction: column;
    }
}

// На телефоне лента файлов снова становится списком: в строку они не помещаются
// и последний файл обрезался краем экрана. Решение и кнопки внизу тоже
// расходятся по строкам, иначе подпись отнимает у кнопок ширину
@media (max-width: 560px) {
    .diff-files {
        flex-direction: column;
        overflow: visible;
    }

    .diff-file {
        min-width: 0;
    }

    .decision-footer > span {
        flex: 1 0 100%;
    }
}
</style>
