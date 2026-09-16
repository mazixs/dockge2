<template>
    <div class="git-ui page create-page">
        <router-link class="back-link" to="/">← {{ $t("gitUiBackStacks") }}</router-link>

        <div class="page-head">
            <div>
                <h1>{{ $t("newStack") }}</h1>
                <p class="page-lede">{{ $t("gitUiNewDescription") }}</p>
            </div>
        </div>

        <!-- Источник выбирается в шапке панели: два способа завести стек - одна
             пара кнопок, а не два разных экрана -->
        <section v-if="!result" class="panel create-card" :aria-busy="busy">
            <div class="panel-bar">
                <div class="source-tabs" role="tablist" :aria-label="$t('gitUiSource')">
                    <button id="new-git-tab" type="button" role="tab" :aria-selected="sourceTab === 'git'" aria-controls="new-git-panel" :tabindex="sourceTab === 'git' ? 0 : -1" :disabled="busy || composeBusy" @click="sourceTab = 'git'" @keydown.right.prevent="selectTab('compose')" @keydown.left.prevent="selectTab('compose')"><InterfaceIcon name="git" />{{ $t("gitUiFromGit") }}</button>
                    <button id="new-compose-tab" type="button" role="tab" :aria-selected="sourceTab === 'compose'" aria-controls="new-compose-panel" :tabindex="sourceTab === 'compose' ? 0 : -1" :disabled="busy || composeBusy" @click="sourceTab = 'compose'" @keydown.right.prevent="selectTab('git')" @keydown.left.prevent="selectTab('git')"><InterfaceIcon name="file" />{{ $t("gitUiPasteCompose") }}</button>
                </div>
            </div>

            <div v-show="sourceTab === 'git'" id="new-git-panel" class="panel-body" role="tabpanel" aria-labelledby="new-git-tab">
                <ol class="create-steps" :aria-label="$t('gitUiCreationSteps')">
                    <li :class="{ active: step === 1, done: step === 2 }"><b>1</b>{{ $t("gitUiSource") }}</li>
                    <li :class="{ active: step === 2 }"><b>2</b>{{ $t("gitUiReviewLaunch") }}</li>
                </ol>

                <div v-if="failure" class="notice failure" role="alert">
                    <p>{{ failure }}</p>
                    <router-link v-if="uncertain" class="btn btn-sm btn-normal" :to="stackPath(name.trim())">{{ $t("gitUiOpenStack") }}</router-link>
                </div>

                <form v-if="step === 1" class="form-stack" @submit.prevent="sourceReady && (step = 2)">
                    <div class="field">
                        <label for="git-repository" class="form-label">{{ $t("gitUiRepository") }}</label>
                        <input id="git-repository" v-model="repository" type="text" class="form-control" placeholder="https://github.com/owner/repository" autocomplete="off" spellcheck="false" required>
                        <p class="form-text">{{ $t("gitUiRepositoryHelp") }}</p>
                    </div>

                    <div class="field-pair">
                        <div class="field">
                            <label for="git-branch" class="form-label">{{ $t("gitUiBranch") }}</label>
                            <input id="git-branch" v-model="branch" type="text" class="form-control" placeholder="main" autocomplete="off" spellcheck="false" required>
                        </div>
                        <div class="field">
                            <label for="git-server" class="form-label">{{ $t("gitUiServer") }}</label>
                            <select id="git-server" v-model="endpoint" class="form-select">
                                <option v-for="(agent, agentEndpoint) in $root.agentList" :key="agentEndpoint" :value="agentEndpoint" :disabled="$root.agentStatusList[agentEndpoint] !== 'online'">
                                    {{ agentEndpoint ? agent.name || agent.url : $t("thisServer") }}{{ $root.agentStatusList[agentEndpoint] === "online" ? "" : " · " + $t("gitUiOffline") }}
                                </option>
                            </select>
                        </div>
                    </div>

                    <footer class="form-footer">
                        <span class="form-text">{{ $t("gitUiNothingStarted") }}</span>
                        <button class="btn btn-primary" :disabled="!sourceReady" type="submit">{{ $t("gitUiContinue") }}</button>
                    </footer>
                </form>

                <form v-else class="form-stack" @submit.prevent="create(true)">
                    <div class="source-summary">
                        <strong>{{ $t("gitUiSourceConfigured") }}</strong>
                        <span>{{ repository }}</span>
                        <small>{{ branch }} · {{ serverName }}</small>
                    </div>

                    <div class="field">
                        <label for="git-stack-name" class="form-label">{{ $t("stackName") }}</label>
                        <input id="git-stack-name" v-model="name" :disabled="busy" type="text" class="form-control" placeholder="my-app" pattern="[a-z0-9][a-z0-9_-]*" autocomplete="off" spellcheck="false" required>
                    </div>

                    <div class="field">
                        <label for="git-compose-file" class="form-label">{{ $t("gitUiComposeFile") }}</label>
                        <input id="git-compose-file" v-model="composeFile" :disabled="busy" type="text" class="form-control" placeholder="compose.yaml" autocomplete="off" spellcheck="false" required>
                        <p class="form-text">{{ $t("gitUiComposeFileHelp") }}</p>
                    </div>

                    <p class="notice">{{ $t("gitUiCloneValidation") }}</p>
                    <div v-if="busy" class="notice" role="status">{{ $t("gitUiCloning") }}</div>

                    <footer class="form-footer">
                        <button class="btn btn-normal" type="button" :disabled="busy" @click="step = 1">← {{ $t("gitUiBack") }}</button>
                        <div class="action-group">
                            <button class="btn btn-normal" type="button" :disabled="!canCreate" @click="create(false)">{{ $t("saveWithoutStarting") }}</button>
                            <button class="btn btn-primary" :disabled="!canCreate" type="submit">{{ $t("deployStack") }}</button>
                        </div>
                    </footer>
                </form>
            </div>

            <div v-show="sourceTab === 'compose'" id="new-compose-panel" class="panel-body" role="tabpanel" aria-labelledby="new-compose-tab">
                <CreateStackSheet ref="composeForm" inline :hide-heading="true" :initial-endpoint="endpoint" @busy-change="composeBusy = $event" />
            </div>
        </section>

        <section v-else class="result-card" role="status">
            <h2>{{ $t(result.deployed ? "gitUiCreatedDeployed" : "gitUiCreatedSaved", [ result.stackName ]) }}</h2>
            <p v-if="result.deploymentError" class="notice failure">{{ $t("gitUiDeploymentFailedSaved") }} {{ result.deploymentError }}</p>
            <p v-else>{{ $t(result.deployed ? "gitUiDeployComplete" : "gitUiSavedDescription") }}</p>
            <router-link class="btn btn-primary" :to="stackPath(result.stackName)">{{ $t("gitUiOpenStack") }}</router-link>
        </section>
    </div>
</template>

<script>
import InterfaceIcon from "../components/InterfaceIcon.vue";
import CreateStackSheet from "../components/CreateStackSheet.vue";
import { isSafeGitRepository } from "../git-ui";

export default {
    components: { InterfaceIcon,
        CreateStackSheet },
    beforeRouteLeave() {
        return !this.busy && !this.composeBusy;
    },
    data() {
        return {
            sourceTab: "git",
            step: 1,
            repository: "",
            branch: "main",
            endpoint: this.$root.selectedEndpoint || "",
            name: "",
            composeFile: "compose.yaml",
            busy: false,
            uncertain: false,
            composeBusy: false,
            failure: "",
            result: null,
        };
    },
    computed: {
        sourceReady() {
            return isSafeGitRepository(this.repository) && this.branch.trim()
                && this.$root.agentStatusList[this.endpoint] === "online";
        },
        canCreate() {
            return this.$root.canManageStacks && !this.busy && !this.uncertain && this.sourceReady
                && /^[a-z0-9][a-z0-9_-]*$/.test(this.name.trim()) && Boolean(this.composeFile.trim());
        },
        serverName() {
            const agent = this.$root.agentList[this.endpoint];
            return this.endpoint ? agent?.name || agent?.url : this.$t("thisServer");
        },
    },
    watch: {
        "$root.socketIO.connected"(connected) {
            if (!connected && this.busy) {
                this.busy = false;
                this.uncertain = true;
                this.failure = this.$t("gitUiResultUnknown");
            }
        },
        "$root.createStackSeed"() {
            this.consumeSeed();
        },
    },
    mounted() {
        this.consumeSeed();
    },
    methods: {
        /** Open the requested accessible tab and place keyboard focus on its label. */
        selectTab(tab) {
            this.sourceTab = tab;
            this.$nextTick(() => document.getElementById(`new-${tab}-tab`)?.focus());
        },
        /** Consume pasted source from memory, keeping it out of URL/history storage. */
        consumeSeed() {
            const seed = this.$root.createStackSeed;
            if (!seed || this.busy || this.composeBusy) {
                return;
            }
            this.sourceTab = "compose";
            this.$root.createStackSeed = "";
            this.$nextTick(() => this.$refs.composeForm?.open(seed));
        },
        /** Resolve an agent-aware route without interpolating unescaped endpoint data. */
        stackPath(name) {
            return `/stack/${encodeURIComponent(name)}${this.endpoint ? `/${encodeURIComponent(this.endpoint)}` : ""}`;
        },
        /** Create a real Git checkout; navigation stays locked until the transaction returns. */
        create(deploy) {
            if (!this.canCreate) {
                return;
            }
            this.busy = true;
            this.failure = "";
            this.$root.emitAgent(this.endpoint, "gitCloneStack", {
                name: this.name.trim(),
                repository: this.repository.trim(),
                branch: this.branch.trim(),
                composeFile: this.composeFile.trim(),
                deploy,
            }, (res) => {
                this.busy = false;
                this.uncertain = false;
                if (!res?.ok) {
                    this.failure = res?.msg || this.$t("gitUiRequestFailed");
                    return;
                }
                this.result = res;
                this.$root.markStackFresh(res.stackName, 60_000);
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../styles/git-pages";

// Создание стека читается в одну колонку: страница не растягивается на всю
// ширину рабочей области, иначе поля уезжают от подписей
.create-page {
    max-width: 760px;
}

// Выбор источника - пара кнопок в шапке панели, а не вкладки поверх нее
.source-tabs {
    display: flex;
    gap: var(--gap-xs);
    min-width: 0;

    button {
        display: inline-flex;
        align-items: center;
        gap: var(--gap-xs);
        min-height: var(--control-height);
        padding: 0 var(--gap-md);
        border: 1px solid transparent;
        border-radius: var(--radius-control);
        background: transparent;
        color: var(--text-muted);
        font-size: var(--text-sm);
        transition: color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
    }

    button:hover:not(:disabled) {
        color: var(--text-strong);
    }

    button[aria-selected="true"] {
        border-color: var(--line-control);
        background-color: var(--surface-raised);
        color: var(--text-strong);
    }
}

.panel-body {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}

// Форма занимает всю панель: колонка тут единственная, сужать ее незачем
.form-stack {
    max-width: none;
    gap: var(--gap-lg);
}

// Шаги: где пользователь сейчас и что будет дальше
.create-steps {
    display: flex;
    justify-content: space-between;
    gap: var(--gap-md);
    margin: 0;
    padding: 0 0 var(--gap-md);
    border-bottom: 1px solid var(--line-hair);
    list-style: none;
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    li {
        display: flex;
        align-items: center;
        gap: var(--gap-sm);
    }

    b {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--gap-lg);
        height: var(--gap-lg);
        border: 1px solid var(--line-hair);
        border-radius: 50%;
        font-weight: var(--weight-medium);
    }

    .active {
        color: var(--text-strong);
    }

    .active b {
        border-color: var(--accent);
        background-color: var(--accent);
        color: var(--text-on-accent);
    }

    .done {
        color: var(--state-running);
    }

    .done b {
        border-color: var(--state-running);
    }
}

.field-pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--gap-md);
}

// Подвал формы: подсказка слева, действия справа, разделены тонкой линией
.form-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--gap-md);
    padding-top: var(--gap-md);
    border-top: 1px solid var(--line-hair);

    .form-text {
        margin: 0;
    }
}

// Что уже выбрано на первом шаге: сводка, а не повтор полей
.source-summary {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
    padding: var(--gap-md);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-control);
    background-color: var(--surface-raised);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    overflow-wrap: anywhere;

    span, small {
        color: var(--text-muted);
        font-size: var(--text-xs);
        line-height: var(--line-xs);
    }
}

:deep(.sheet-layer.inline .brief) {
    padding: 0 0 var(--gap-lg);
}

:deep(.sheet-layer.inline footer) {
    position: static;
    margin-top: var(--gap-sm);
    background: transparent;
}

@media (max-width: 720px) {
    // Имя способа не переносится: строка в две линии делала одну кнопку выше
    // другой, и пара переставала читаться как переключатель
    .source-tabs button {
        flex: 1;
        justify-content: center;
        padding: 0 var(--gap-sm);
        white-space: nowrap;
    }

    .field-pair {
        grid-template-columns: minmax(0, 1fr);
    }

    .action-group {
        width: 100%;
    }

    .action-group .btn {
        flex: 1;
    }
}
</style>
