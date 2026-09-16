<template>
    <!-- MCP: доступ, ключи, ожидающие подтверждения операции и журнал. Каждая
         часть - своя панель, поэтому пароль подтверждения виден там, где нужен -->
    <div class="mcp">
        <p v-if="error" class="alert alert-danger" role="alert">{{ $t("mcpError") }}</p>
        <p v-if="loading" class="form-text" role="status">{{ $t("loading") }}</p>

        <!-- Раздел не прочитан: форму показывать нельзя. В ней стояли бы не настоящие
             настройки, а пустые значения по умолчанию, и сохранение затерло бы ими
             то, что настроено. Поэтому здесь причина и повтор, а не пустая форма -->
        <section v-else-if="loadFailed" class="panel" aria-labelledby="mcp-heading">
            <div class="panel-bar">
                <h2 id="mcp-heading" class="panel-title"><InterfaceIcon name="network" />{{ $t("mcpTitle") }}</h2>
            </div>

            <!-- Та же анатомия, что у выключенной консоли: заголовок называет
                 состояние, подсказка объясняет причину. Повтор стоит только там,
                 где он может помочь: при отказе в доступе та же выдача повторится
                 слово в слово, а кнопка обещала бы иное -->
            <div class="panel-body" role="alert">
                <EmptyState
                    :title="$t(loadDenied ? 'mcpLoadDeniedTitle' : 'mcpLoadFailedTitle')"
                    :hint="$t(loadDenied ? 'mcpLoadDenied' : 'mcpLoadFailed')"
                >
                    <button v-if="!loadDenied" type="button" class="btn btn-sm btn-normal" @click="load">{{ $t("retry") }}</button>
                </EmptyState>
            </div>
        </section>

        <template v-else>
            <section class="panel" aria-labelledby="mcp-heading">
                <div class="panel-bar">
                    <h2 id="mcp-heading" class="panel-title"><InterfaceIcon name="network" />{{ $t("mcpTitle") }}</h2>
                </div>

                <form class="panel-body form-stack" @submit.prevent="saveConfig">
                    <p class="form-text">{{ $t("mcpHint") }}</p>

                    <label class="form-check">
                        <input v-model="config.enabled" type="checkbox" class="form-check-input">
                        <span class="form-check-label">{{ $t("mcpEnable") }}</span>
                    </label>

                    <div class="field">
                        <label for="mcp-url" class="form-label">{{ $t("mcpURL") }}</label>
                        <input id="mcp-url" v-model="config.url" class="form-control" type="url" required>
                    </div>

                    <div class="field">
                        <label for="mcp-password" class="form-label">{{ $t("Password") }}</label>
                        <input id="mcp-password" v-model="password" class="form-control" type="password" autocomplete="current-password" required>
                        <p class="form-text">{{ $t("mcpPasswordHint") }}</p>
                    </div>

                    <div class="actions">
                        <button class="btn btn-primary" :disabled="busy">{{ $t("Save") }}</button>
                    </div>
                </form>
            </section>

            <!-- Секрет виден один раз: полоса внимания, а не строка среди прочих -->
            <div v-if="secret" class="alert alert-warning mcp-secret-box" role="status">
                <p class="mcp-secret-note">{{ $t("mcpSecretOnce") }}</p>
                <code class="mcp-secret">{{ secret }}</code>
                <button type="button" class="btn btn-sm btn-normal" @click="secret = ''">{{ $t("Close") }}</button>
            </div>

            <section v-if="creating || editing" class="panel">
                <div class="panel-bar">
                    <h2 class="panel-title"><InterfaceIcon name="key" />{{ $t(editing ? "mcpReduce" : "mcpCreate") }}</h2>
                </div>

                <form class="panel-body form-stack" @submit.prevent="issue">
                    <div class="field">
                        <label for="mcp-key-name" class="form-label">{{ $t("mcpKeyName") }}</label>
                        <input id="mcp-key-name" v-model="form.name" class="form-control" maxlength="80" required>
                    </div>

                    <div class="field">
                        <label for="mcp-owner" class="form-label">{{ $t("mcpOwner") }}</label>
                        <select id="mcp-owner" v-model="form.userId" class="form-select" required :disabled="!!editing">
                            <option v-for="user in users" :key="user.id" :value="user.id">{{ user.name }}</option>
                        </select>
                    </div>

                    <div class="field">
                        <label for="mcp-days" class="form-label">{{ $t("mcpDays") }}</label>
                        <input id="mcp-days" v-model.number="form.days" class="form-control" type="number" min="1" max="90" required>
                    </div>

                    <div class="field">
                        <label for="mcp-role" class="form-label">{{ $t("usersRole") }}</label>
                        <select id="mcp-role" v-model="form.role" class="form-select" @change="roleChanged">
                            <option value="viewer">{{ $t("usersRole_viewer") }}</option>
                            <option value="operator">{{ $t("usersRole_operator") }}</option>
                        </select>
                    </div>

                    <template v-if="form.role === 'operator'">
                        <p class="alert alert-warning">{{ $t("mcpOperatorWarning") }}</p>

                        <div class="field">
                            <label for="mcp-mode" class="form-label">{{ $t("mcpMode") }}</label>
                            <select id="mcp-mode" v-model="form.mode" class="form-select">
                                <option value="readonly">{{ $t("mcpMode_readonly") }}</option>
                                <option value="approval">{{ $t("mcpMode_approval") }}</option>
                                <option value="automatic">{{ $t("mcpMode_automatic") }}</option>
                            </select>
                        </div>

                        <fieldset class="field">
                            <legend class="form-label">{{ $t("mcpPermissions") }}</legend>
                            <label v-for="permission in permissions" :key="permission" class="form-check">
                                <input v-model="form.actions" class="form-check-input" type="checkbox" :value="permission">
                                <span class="form-check-label">{{ $t(`mcpPermission_${permission}`) }}</span>
                            </label>
                        </fieldset>
                    </template>

                    <fieldset class="field">
                        <legend class="form-label">{{ $t("mcpStacks") }}</legend>
                        <label v-for="stack in stacks" :key="stack.id" class="form-check">
                            <input v-model="selected" class="form-check-input" type="checkbox" :value="`local|${stack.id}`">
                            <span class="form-check-label">{{ stack.name }}<span v-if="stack.reserved" class="reserved">{{ $t("mcpReserved") }}</span></span>
                        </label>

                        <div v-for="peer in peers" :key="peer.id" class="peer">
                            <span class="peer-name">{{ peer.name }}</span>
                            <label v-for="id in peer.stacks" :key="id" class="form-check">
                                <input v-model="selected" class="form-check-input" type="checkbox" :value="`${peer.id}|${id}`">
                                <span class="form-check-label">{{ id }}</span>
                            </label>
                        </div>
                    </fieldset>

                    <p v-if="form.role === 'viewer'" class="form-text">{{ $t("mcpViewerOnly") }}</p>
                    <p v-if="editing" class="form-text">{{ $t("mcpReduceHint") }}</p>

                    <div class="actions">
                        <button class="btn btn-primary" :disabled="busy || !password || !selected.length">{{ $t(editing ? "mcpReduce" : "mcpCreate") }}</button>
                        <button type="button" class="btn btn-normal" @click="cancelEdit">{{ $t("cancel") }}</button>
                    </div>
                </form>
            </section>

            <section class="panel">
                <div class="panel-bar">
                    <h2 class="panel-title"><InterfaceIcon name="key" />{{ $t("mcpKeys") }}</h2>
                    <span class="panel-meta">{{ keys.length }}</span>
                    <button v-if="!creating && !editing" class="btn btn-sm btn-primary" @click="creating = true">
                        <font-awesome-icon icon="plus" />{{ $t("mcpCreate") }}
                    </button>
                </div>

                <div v-if="!keys.length" class="panel-body">
                    <p class="form-text">{{ $t("mcpNoKeys") }}</p>
                </div>

                <div v-else class="panel-rows">
                    <div v-for="key in keys" :key="key.id" class="panel-row">
                        <div class="row-main">
                            <span class="row-name">{{ key.name }}</span>
                            <span class="row-meta">{{ $t(`usersRole_${key.role}`) }} · {{ $t("mcpExpires") }} {{ formatDate(key.expires_at) }} · {{ $t("mcpLastUsed") }} {{ formatDate(key.last_used_at) }}</span>
                            <span class="row-meta">{{ scopeNames(key.stacks) }}</span>
                        </div>

                        <div class="actions">
                            <template v-if="key.revoked_at">
                                <span class="row-meta">{{ $t("mcpRevoked") }}</span>
                            </template>
                            <template v-else>
                                <button class="btn btn-sm btn-normal" :disabled="busy" @click="edit(key)">{{ $t("mcpReduce") }}</button>
                                <button class="btn btn-sm btn-normal btn-danger-text" :disabled="busy || !password" @click="revoke(key.id)">{{ $t("mcpRevoke") }}</button>
                            </template>
                        </div>
                    </div>
                </div>

                <div class="panel-body reserve">
                    <details>
                        <summary>{{ $t("mcpReserve") }}</summary>
                        <form class="form-stack reserve-form" @submit.prevent="reserve">
                            <div class="field">
                                <label for="mcp-reserve" class="form-label">{{ $t("mcpReserveName") }}</label>
                                <input id="mcp-reserve" v-model="reserveName" class="form-control" maxlength="64" required>
                                <p class="form-text">{{ $t("mcpReserveHint") }}</p>
                            </div>
                            <div class="actions">
                                <button class="btn btn-sm btn-normal" :disabled="busy || !password">{{ $t("mcpReserve") }}</button>
                            </div>
                        </form>
                    </details>

                    <details>
                        <summary>{{ $t("mcpConnectionExample") }}</summary>
                        <pre>{{ connectionExample }}</pre>
                    </details>
                </div>
            </section>

            <section class="panel">
                <div class="panel-bar">
                    <h2 class="panel-title"><InterfaceIcon name="check" />{{ $t("mcpPending") }}</h2>
                    <span class="panel-meta">{{ pending.length }}</span>
                </div>

                <div v-if="!pending.length" class="panel-body">
                    <p class="form-text">{{ $t("mcpNoPending") }}</p>
                </div>

                <div v-else class="panel-rows">
                    <div v-for="operation in pending" :key="operation.operation_id" class="panel-row">
                        <div class="row-main">
                            <span class="row-name">{{ actionName(operation.action) }}</span>
                            <span class="row-meta">{{ resourceName(operation.server_id, operation.stack_id) }}</span>
                        </div>
                        <button class="btn btn-sm btn-normal" :disabled="busy || !password" @click="review(operation)">{{ $t("mcpReview") }}</button>
                    </div>
                </div>

                <div v-if="reviewed" class="panel-body form-stack review">
                    <h3>{{ actionName(reviewed.operation.action) }}</h3>
                    <p class="alert alert-warning">{{ $t("mcpReviewWarning") }}</p>

                    <template v-if="reviewed.value.files">
                        <div v-for="file in reviewed.value.files" :key="file.name" class="review-file">
                            <span class="row-name">{{ file.name }}<span v-if="file.choice" class="row-meta">{{ file.choice }}</span></span>
                            <p v-if="file.hidden" class="form-text">{{ $t("mcpHidden") }}</p>
                            <div v-else class="mcp-comparison">
                                <div><span class="form-label">{{ $t("mcpBefore") }}</span><pre>{{ file.before }}</pre></div>
                                <div><span class="form-label">{{ $t("mcpAfter") }}</span><pre>{{ file.after }}</pre></div>
                            </div>
                        </div>
                    </template>
                    <pre v-else>{{ JSON.stringify(reviewed.value, null, 2) }}</pre>

                    <div class="actions">
                        <button class="btn btn-primary" :disabled="busy" @click="approve">{{ $t("mcpApprove") }}</button>
                        <button class="btn btn-normal" @click="reviewed = null">{{ $t("cancel") }}</button>
                    </div>
                </div>
            </section>

            <section class="panel">
                <div class="panel-bar">
                    <h2 class="panel-title"><InterfaceIcon name="logs" />{{ $t("mcpAudit") }}</h2>
                </div>

                <div v-if="!audit.length" class="panel-body">
                    <p class="form-text">{{ $t("mcpNoAudit") }}</p>
                </div>

                <div v-else class="panel-rows">
                    <p v-for="entry in audit" :key="entry.id" class="panel-row audit-row">{{ formatDate(entry.at) }} · {{ entry.tool }} · {{ entry.outcome }}</p>
                </div>
            </section>
        </template>
    </div>
</template>

<script>
import { MCP_ACTIONS } from "../../../../common/mcp";
export default {
    data() {
        return { creating: false,
            permissions: MCP_ACTIONS,
            peers: [],
            pending: [],
            reviewed: null,
            editing: "",
            selected: [],
            reserveName: "",
            loading: true,
            busy: false,
            error: false,
            loadFailed: false,
            loadDenied: false,
            password: "",
            secret: "",
            config: { enabled: false,
                url: "" },
            form: { name: "",
                userId: "",
                days: 30,
                role: "viewer",
                actions: [],
                mode: "readonly" },
            users: [],
            stacks: [],
            keys: [],
            audit: [] };
    },
    computed: {
        connectionExample() {
            return `MCP_URL=${this.config.url}\nDOCKGE_MCP_KEY=<key>\nAuthorization: Bearer ${"${DOCKGE_MCP_KEY}"}`;
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        async request(path = "", data) {
            let dev = process.env.NODE_ENV === "development";
            try {
                dev ||= localStorage.dev === "dev";
            } catch { /* Storage can be unavailable. */ }
            const base = dev ? `${location.protocol}//${location.hostname}:5001` : location.origin;
            const response = await fetch(`${base}/api/mcp${path}`, { credentials: "include",
                method: data ? "POST" : "GET",
                headers: data ? { "Content-Type": "application/json" } : {},
                body: data ? JSON.stringify({ password: this.password,
                    data }) : undefined });
            if (!response.ok) {
                const failure = new Error("mcpRequestFailed");
                failure.status = response.status;
                throw failure;
            }
            return response.json();
        },
        async load() {
            this.loading = true;
            try {
                Object.assign(this, await this.request());
                this.form.userId ||= this.users[0]?.id || "";
                this.loadFailed = false;
                this.loadDenied = false;
            } catch (failure) {
                // Не удалось прочитать раздел - это не отказ в действии: совет
                // проверить пароль владельца относится только к отправке формы.
                // Отказ в доступе назван отдельно: ключи выдаются под учетную
                // запись, и при выключенном входе сервер эту запись не видит
                this.loadFailed = true;
                this.loadDenied = failure?.status === 403;
            } finally {
                this.loading = false;
            }
        },
        async mutate(action, data) {
            this.busy = true;
            this.error = false;
            try {
                const result = await this.request(`/${action}`, data);
                await this.load();
                return result;
            } catch {
                this.error = true;
                return null;
            } finally {
                this.busy = false;
            }
        },
        saveConfig() {
            return this.mutate("config", this.config);
        },
        async issue() {
            this.secret = "";
            const resources = {};
            for (const entry of this.selected) {
                const [ server, id ] = entry.split("|");
                (resources[server] ||= []).push(id);
            }
            const value = { ...this.form,
                resources,
                servers: Object.keys(resources),
                stacks: [ ...new Set(Object.values(resources).flat()) ] };
            const result = await this.mutate(this.editing ? "reduce" : "issue", this.editing ? { id: this.editing,
                value } : value);
            this.secret = result?.secret || "";
            if (result) {
                this.cancelEdit();
            }
        },
        roleChanged() {
            if (this.form.role === "viewer") {
                this.form.actions = [];
                this.form.mode = "readonly";
            }
        },
        edit(key) {
            this.creating = true;
            this.editing = key.id;
            this.form = { name: key.name,
                userId: key.user_id,
                role: key.role,
                actions: JSON.parse(key.actions),
                mode: key.mode,
                days: Math.max(1, Math.ceil((Number(key.expires_at) - Date.now()) / 86400000)) };
            this.selected = Object.entries(JSON.parse(key.resources)).flatMap(([ server, ids ]) => ids.map(id => `${server}|${id}`));
        },
        actionName(action) {
            return this.$t(`mcpAction_${action}`);
        },
        cancelEdit() {
            this.creating = false;
            this.editing = "";
            this.form = { name: "",
                userId: this.users[0]?.id || "",
                role: "viewer",
                actions: [],
                mode: "readonly",
                days: 30 };
            this.selected = [];
        },
        async reserve() {
            await this.mutate("reserve", { name: this.reserveName });
            this.reserveName = "";
        },
        async review(operation) {
            const value = await this.mutate("review", { id: operation.operation_id });
            if (value) {
                this.reviewed = { operation,
                    value };
            }
        },
        async approve() {
            await this.mutate("approve", { id: this.reviewed.operation.operation_id });
            this.reviewed = null;
        },
        /**
         * Имя ресурса словами: у своего сервера довольно имени стека, у чужого
         * нужно еще имя сервера - иначе одинаковые имена не различить
         * @param {string} server Идентификатор сервера
         * @param {string} id Идентификатор стека
         * @returns {string} Читаемое имя ресурса
         */
        resourceName(server, id) {
            const stack = this.stacks.find((item) => item.id === id)?.name || id;

            if (!server || server === "local") {
                return stack;
            }

            return `${this.peers.find((peer) => peer.id === server)?.name || server}: ${stack}`;
        },
        revoke(id) {
            return this.mutate("revoke", { id });
        },
        formatDate(value) {
            return value ? new Date(Number(value)).toLocaleString() : "-";
        },
        /**
         * Область ключа хранится парами "сервер|стек": показывать их как есть
         * нельзя, читателю нужны имена
         * @param {string} value Список областей в JSON
         * @returns {string} Имена стеков через запятую
         */
        scopeNames(value) {
            const scopes = JSON.parse(value);

            return scopes
                .map((scope) => {
                    const separator = String(scope).indexOf("|");

                    return separator === -1
                        ? this.resourceName("", String(scope))
                        : this.resourceName(String(scope).slice(0, separator), String(scope).slice(separator + 1));
                })
                .join(", ");
        },
    },
};
</script>

<style scoped lang="scss">
.mcp {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}

.alert {
    margin: 0;
}

fieldset.field {
    border: 0;
    padding: 0;
}

legend.form-label {
    float: none;
    width: auto;
    padding: 0;
}

.reserved,
.peer-name {
    margin-left: var(--gap-sm);
    color: var(--text-faint);
    font-size: var(--text-sm);
}

.peer {
    margin-top: var(--gap-sm);
}

.peer-name {
    display: block;
    margin: 0 0 var(--gap-xs);
    color: var(--text-muted);
}

.row-main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
}

.row-name {
    color: var(--text-strong);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
}

.row-meta {
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    overflow-wrap: anywhere;
}

.audit-row {
    display: block;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-family: var(--font-mono);
}

// Секрет виден один раз: он стоит отдельной полосой и читается моноширинным
.mcp-secret-box {
    display: flex;
    flex-direction: column;
    align-items: start;
    gap: var(--gap-sm);
}

.mcp-secret-note {
    margin: 0;
}

.mcp-secret {
    display: block;
    width: 100%;
    overflow-wrap: anywhere;
    font-size: var(--text-code);
}

.reserve {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
}

details summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--text-sm);
}

.reserve-form {
    margin-top: var(--gap-md);
}

.review h3 {
    margin: 0;
}

.review-file {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
}

.mcp-comparison {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--gap-md);
}

.mcp-comparison .form-label {
    color: var(--text-muted);
    font-size: var(--text-sm);
}

pre {
    max-height: 24rem;
    margin: var(--gap-xs) 0 0;
    padding: var(--gap-sm);
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background-color: var(--surface-sunken);
    border-radius: var(--radius-control);
    font-size: var(--text-code);
}

@media (max-width: 700px) {
    .mcp-comparison {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
