<template>
    <div class="git-ui page create-page">
        <router-link class="back-link" to="/">← {{ $t("gitUiBackStacks") }}</router-link>

        <div class="page-head create-head">
            <span class="create-mark" aria-hidden="true"><InterfaceIcon name="box" /></span>
            <h1>{{ $t("newStack") }}</h1>
            <p class="page-lede">{{ $t("gitUiNewDescription") }}</p>
        </div>

        <!-- Порядок блоков карточки: сначала шаг, на котором стоит пользователь,
             потом способ завести стек, потом сама форма. Шаг - рамка для всего
             остального, поэтому он не может стоять ниже выбора источника -->
        <section v-if="!result" class="panel create-card" :class="{ wide: composeBusy }" :aria-busy="busy">
            <div class="create-top">
                <ol class="create-steps" :aria-label="$t('gitUiCreationSteps')">
                    <li :class="{ active: currentStep === 1, done: currentStep === 2 }"><b>1</b>{{ $t("gitUiSource") }}</li>
                    <li :class="{ active: currentStep === 2 }"><b>2</b>{{ $t("gitUiReviewLaunch") }}</li>
                </ol>

                <div class="source-tabs" role="tablist" :aria-label="$t('gitUiSource')">
                    <button id="new-git-tab" type="button" role="tab" :aria-selected="sourceTab === 'git'" aria-controls="new-git-panel" :tabindex="sourceTab === 'git' ? 0 : -1" :disabled="busy || composeBusy" @click="sourceTab = 'git'" @keydown.right.prevent="selectTab('compose')" @keydown.left.prevent="selectTab('compose')"><InterfaceIcon name="git" />{{ $t("gitUiFromGit") }}</button>
                    <button id="new-compose-tab" type="button" role="tab" :aria-selected="sourceTab === 'compose'" aria-controls="new-compose-panel" :tabindex="sourceTab === 'compose' ? 0 : -1" :disabled="busy || composeBusy" @click="sourceTab = 'compose'" @keydown.right.prevent="selectTab('git')" @keydown.left.prevent="selectTab('git')"><InterfaceIcon name="file" />{{ $t("gitUiPasteCompose") }}</button>
                </div>

                <p class="tabs-note">{{ $t("gitUiComposeAcceptsDockerRun") }}</p>
            </div>

            <div v-show="sourceTab === 'git'" id="new-git-panel" class="panel-body" role="tabpanel" aria-labelledby="new-git-tab">
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
                            <select v-if="branches.length" id="git-branch" v-model="branch" class="form-select">
                                <option v-for="branchName in branches" :key="branchName" :value="branchName">{{ branchName }}</option>
                            </select>
                            <input v-else id="git-branch" v-model="branch" type="text" class="form-control" placeholder="main" autocomplete="off" spellcheck="false" required>
                            <p class="form-text branch-line">
                                <button v-if="!branches.length" class="btn btn-quiet btn-sm" type="button" :disabled="!canListBranches" @click="loadBranches">{{ branchesBusy ? $t("gitUiBranchesLoading") : $t("gitUiLoadBranches") }}</button>
                                <button v-else class="btn btn-quiet btn-sm" type="button" @click="branches = []">{{ $t("gitUiBranchesTyped") }}</button>
                                <span v-if="branchesFailure">{{ branchesFailure }}</span>
                            </p>
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
                        <button class="btn btn-primary" :disabled="!sourceReady" type="submit">{{ $t("gitUiContinue") }} <span aria-hidden="true">→</span></button>
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
            branches: [],
            branchesBusy: false,
            branchesFailure: "",
            failure: "",
            result: null,
        };
    },
    computed: {
        sourceReady() {
            return isSafeGitRepository(this.repository.trim()) && this.branch.trim()
                && this.$root.agentStatusList[this.endpoint] === "online";
        },
        canCreate() {
            return this.$root.canManageStacks && !this.busy && !this.uncertain && this.sourceReady
                && /^[a-z0-9][a-z0-9_-]*$/.test(this.name.trim()) && Boolean(this.composeFile.trim());
        },
        // Список веток запрашивается у чужого сервера, поэтому кнопка доступна
        // только когда адрес уже разобран и выбранный агент на связи
        canListBranches() {
            return !this.branchesBusy && isSafeGitRepository(this.repository.trim())
                && this.$root.agentStatusList[this.endpoint] === "online";
        },
        // Дорожка шагов стоит над выбором источника, поэтому номер шага нужен
        // и для вставки Compose: там единственная форма, и второй шаг наступает
        // тогда, когда она уже разворачивает стек
        currentStep() {
            if (this.sourceTab === "compose") {
                return this.composeBusy ? 2 : 1;
            }
            return this.step;
        },
        serverName() {
            const agent = this.$root.agentList[this.endpoint];
            return this.endpoint ? agent?.name || agent?.url : this.$t("thisServer");
        },
    },
    watch: {
        // Ветки принадлежат конкретному адресу: сменился адрес или сервер -
        // прежний список больше ничего не описывает
        repository() {
            this.branches = [];
            this.branchesFailure = "";
        },
        endpoint() {
            this.branches = [];
            this.branchesFailure = "";
        },
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
        /** Ask the remote which branches it has, on request rather than while typing. */
        loadBranches() {
            if (!this.canListBranches) {
                return;
            }
            this.branchesBusy = true;
            this.branchesFailure = "";
            this.$root.emitAgent(this.endpoint, "gitListBranches", this.repository.trim(), (res) => {
                this.branchesBusy = false;
                if (!res?.ok) {
                    this.branchesFailure = res?.msg || this.$t("gitUiRequestFailed");
                    return;
                }
                this.branches = res.branches || [];
                if (!this.branches.length) {
                    this.branchesFailure = this.$t("gitUiBranchesEmpty");
                    return;
                }
                if (!this.branches.includes(this.branch)) {
                    this.branch = this.branches[0];
                }
            });
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

// Создание стека читается в одну колонку по центру рабочей области: узкая
// форма, прижатая к левому краю широкого экрана, читается как обрезанная
.create-card {
    width: 100%;
    max-width: 560px;
    margin: 0 auto;
}

// Пока стек разворачивается, в карточке уже не форма, а ход команды: список
// сервисов и время в колонке шириной с поле ввода читались как обрезанные
.create-card.wide {
    max-width: 820px;
}

// Знак, имя экрана и строка объяснения стоят на одной оси с формой
.create-head {
    flex-direction: column;
    align-items: center;
    gap: var(--gap-sm);
    margin-bottom: var(--gap-xl);
    text-align: center;

    .page-lede {
        margin: 0;
    }
}

.create-mark {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-card);
    background-color: var(--accent-soft);
    color: var(--accent-text);
    font-size: var(--icon-lg);
}

// Шаг и выбор источника - одна шапка карточки над формой
.create-top {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--gap-md);
    padding: var(--gap-md) var(--gap-md) 0;
}

// Выбор источника - сегментный переключатель во всю ширину: два равноправных
// пути должны и выглядеть равноправными
.source-tabs {
    display: flex;
    gap: var(--gap-xs);
    min-width: 0;
    padding: var(--gap-xs);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-control);
    background-color: var(--surface-sunken);

    button {
        display: inline-flex;
        flex: 1;
        align-items: center;
        justify-content: center;
        gap: var(--gap-xs);
        min-height: var(--control-height);
        padding: 0 var(--gap-sm);
        border: 1px solid transparent;
        border-radius: var(--radius-chip);
        background: transparent;
        color: var(--text-muted);
        font-size: var(--text-sm);
        white-space: nowrap;
        transition: color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
    }

    button:hover:not(:disabled) {
        color: var(--text-strong);
    }

    button[aria-selected="true"] {
        border-color: var(--line-hair);
        background-color: var(--surface-raised);
        color: var(--text-strong);
        font-weight: var(--weight-medium);
    }
}

// Про распознавание docker run узнать больше неоткуда: вкладка называется
// "Вставить Compose", а команду она тоже принимает
.tabs-note {
    margin: 0;
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
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

// Шаги: где пользователь сейчас и что будет дальше. Между ними линия, иначе
// это не дорожка, а две несвязанные надписи по углам карточки
.create-steps {
    display: flex;
    align-items: center;
    gap: var(--gap-md);
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    li {
        display: flex;
        align-items: center;
        gap: var(--gap-sm);
        min-width: 0;
    }

    // Линия принадлежит первому шагу, а не отдельному элементу списка:
    // в дорожке ровно два пункта, и лишний li сломал бы ее для чтения с экрана
    li:first-child {
        flex: 1;
    }

    li:first-child::after {
        content: "";
        flex: 1;
        height: 1px;
        background-color: var(--line-hair);
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

// Кнопка списка веток живет в строке подсказки под полем: это уточнение
// поля, а не отдельное действие формы
.branch-line {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
    flex-wrap: wrap;

    // Кнопка звучит как ссылка в подсказке, а не как действие формы: рамка
    // сделала бы ее заметнее поля, к которому она относится
    .btn {
        padding: 0;
        min-height: 0;
        border: 0;
        background: none;
        color: var(--accent-text);
        font-size: var(--text-sm);
        line-height: var(--line-sm);
        text-decoration: underline;
    }

    .btn:disabled {
        color: var(--text-faint);
        text-decoration: none;
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
        font-size: var(--text-sm);
        line-height: var(--line-sm);
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
