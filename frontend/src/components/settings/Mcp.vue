<template>
    <!-- MCP: status and access, keys, client setup, reserved names, approvals and the log.
         Each part is its own panel, and each reports its own result where it happened -->
    <div class="mcp">
        <p v-if="loading" class="form-text" role="status">{{ $t("loading") }}</p>

        <!-- Without the real settings the form would hold defaults, and saving would
             overwrite what is configured. So the reason and a retry, not an empty form -->
        <section v-else-if="loadFailed" class="panel" aria-labelledby="mcp-heading">
            <div class="panel-bar">
                <h2 id="mcp-heading" class="panel-title"><InterfaceIcon name="network" />{{ $t("mcpTitle") }}</h2>
            </div>

            <!-- A retry is offered only where it can help: a denial would repeat word for word -->
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
                    <StateChip :state="stateChip.state" :label="stateChip.label" :attention="stateChip.attention" />
                </div>

                <div class="panel-body form-stack">
                    <p class="form-text">{{ $t("mcpHint") }}</p>

                    <dl class="mcp-status" :aria-label="$t('mcpStatus')">
                        <div>
                            <dt>{{ $t("mcpEndpoint") }}</dt>
                            <dd><code v-if="saved.url">{{ saved.url }}</code><span v-else>{{ $t("mcpNotConfigured") }}</span></dd>
                        </div>
                        <div>
                            <dt>{{ $t("mcpEncryption") }}</dt>
                            <dd :class="{ 'status-warning': encryption === 'insecure' }">{{ encryption ? $t(`mcpEncryption_${encryption}`) : "-" }}</dd>
                        </div>
                        <div>
                            <dt>{{ $t("mcpActiveKeys") }}</dt>
                            <dd>{{ activeKeys }}</dd>
                        </div>
                        <div>
                            <dt>{{ $t("mcpLastConnection") }}</dt>
                            <dd>{{ status.lastConnection ? entryLine(status.lastConnection) : $t("mcpNever") }}</dd>
                        </div>
                        <div>
                            <dt>{{ $t("mcpLastRefusal") }}</dt>
                            <dd v-if="status.lastRefusal">
                                {{ entryLine(status.lastRefusal) }}
                                <span class="status-reason">{{ reasonText(status.lastRefusal) }}</span>
                            </dd>
                            <dd v-else>{{ $t("mcpNever") }}</dd>
                        </div>
                    </dl>
                </div>

                <form class="panel-body form-stack" @submit.prevent="saveConfig">
                    <label class="form-check">
                        <input v-model="config.enabled" type="checkbox" class="form-check-input">
                        <span class="form-check-label">{{ $t("mcpEnable") }}</span>
                    </label>

                    <div class="field">
                        <label for="mcp-url" class="form-label">{{ $t("mcpURL") }}</label>
                        <input id="mcp-url" v-model.trim="config.url" class="form-control" type="url" required aria-describedby="mcp-url-hint">
                        <p id="mcp-url-hint" class="form-text">{{ $t("mcpURLHint") }}</p>
                        <p v-if="hostMismatch" class="alert alert-warning">{{ $t("mcpHostMismatch", { host: pageHost }) }}</p>
                    </div>

                    <template v-if="urlInfo.insecure">
                        <label class="form-check">
                            <input v-model="config.allowInsecureHttp" type="checkbox" class="form-check-input">
                            <span class="form-check-label">{{ $t("mcpAllowInsecure") }}</span>
                        </label>
                        <p class="alert alert-warning">{{ $t("mcpInsecureWarning") }}</p>
                    </template>

                    <div class="field">
                        <label for="mcp-password" class="form-label">{{ $t("Password") }}</label>
                        <input id="mcp-password" v-model="password" class="form-control" type="password" autocomplete="current-password" required>
                        <p class="form-text">{{ $t("mcpPasswordHint") }}</p>
                    </div>

                    <div class="actions">
                        <button class="btn btn-primary" :disabled="busy">{{ $t("Save") }}</button>
                    </div>
                    <p v-if="notice.config" :class="noticeClass(notice.config)" :role="notice.config.ok ? 'status' : 'alert'">{{ notice.config.text }}</p>
                </form>
            </section>

            <!-- Shown once: a band of attention, not a line among others -->
            <div v-if="secret" class="alert alert-warning mcp-secret-box" role="status">
                <p class="mcp-secret-note">{{ $t("mcpSecretOnce") }}</p>
                <code class="mcp-secret">{{ secret }}</code>
                <p class="mcp-secret-note">{{ $t("mcpSecretEnv") }}</p>
                <div class="actions">
                    <button type="button" class="btn btn-sm btn-primary" @click="copy(secret)">{{ $t("mcpCopy") }}</button>
                    <button type="button" class="btn btn-sm btn-normal" @click="secret = ''">{{ $t("Close") }}</button>
                </div>
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
                    <p v-if="!password" class="form-text">{{ $t("mcpPasswordFirst") }}</p>
                    <p v-if="notice.form" :class="noticeClass(notice.form)" role="alert">{{ notice.form.text }}</p>
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

                <div v-if="notice.keys" class="panel-body">
                    <p :class="noticeClass(notice.keys)" :role="notice.keys.ok ? 'status' : 'alert'">{{ notice.keys.text }}</p>
                </div>
            </section>

            <section class="panel" aria-labelledby="mcp-connect-heading">
                <div class="panel-bar">
                    <h2 id="mcp-connect-heading" class="panel-title"><InterfaceIcon name="terminal" />{{ $t("mcpConnect") }}</h2>
                </div>

                <div class="panel-body form-stack">
                    <p v-if="!saved.enabled || !saved.url" class="form-text">{{ $t("mcpConnectDisabled") }}</p>
                    <template v-else>
                        <p class="form-text">{{ $t("mcpConnectHint") }}</p>

                        <div class="field">
                            <label for="mcp-client" class="form-label">{{ $t("mcpClient") }}</label>
                            <select id="mcp-client" v-model="client" class="form-select">
                                <option v-for="item in clients" :key="item.id" :value="item.id">{{ item.label }}</option>
                            </select>
                        </div>

                        <p class="form-text">{{ snippet.where }}</p>
                        <pre class="mcp-snippet">{{ snippet.text }}</pre>
                        <p v-if="snippet.hint" class="form-text">{{ snippet.hint }}</p>

                        <div class="actions">
                            <button type="button" class="btn btn-sm btn-normal" @click="copy(snippet.text)">{{ $t("mcpCopy") }}</button>
                        </div>
                    </template>
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

                <div v-if="notice.pending" class="panel-body">
                    <p :class="noticeClass(notice.pending)" :role="notice.pending.ok ? 'status' : 'alert'">{{ notice.pending.text }}</p>
                </div>
            </section>

            <section class="panel" aria-labelledby="mcp-reservations-heading">
                <div class="panel-bar">
                    <h2 id="mcp-reservations-heading" class="panel-title"><InterfaceIcon name="git" />{{ $t("mcpReservations") }}</h2>
                    <span class="panel-meta">{{ reservations.length }}</span>
                </div>

                <div class="panel-body form-stack">
                    <p class="form-text">{{ $t("mcpReserveHint") }}</p>
                    <p v-if="!reservations.length" class="form-text">{{ $t("mcpNoReservations") }}</p>
                </div>

                <div v-if="reservations.length" class="panel-rows">
                    <div v-for="stack in reservations" :key="stack.id" class="panel-row">
                        <div class="row-main">
                            <span class="row-name">{{ stack.name }}</span>
                            <span class="row-meta">{{ reservationKeys(stack.id) }}</span>
                        </div>
                        <button class="btn btn-sm btn-normal btn-danger-text" :disabled="busy || !password" @click="unreserve(stack)">{{ $t("mcpUnreserve") }}</button>
                    </div>
                </div>

                <form class="panel-body form-stack" @submit.prevent="reserve">
                    <div class="field">
                        <label for="mcp-reserve" class="form-label">{{ $t("mcpReserveName") }}</label>
                        <input id="mcp-reserve" v-model.trim="reserveName" class="form-control" maxlength="64" required>
                    </div>
                    <div class="actions">
                        <button class="btn btn-sm btn-normal" :disabled="busy || !password">{{ $t("mcpReserve") }}</button>
                    </div>
                    <p v-if="!password" class="form-text">{{ $t("mcpPasswordFirst") }}</p>
                    <p v-if="notice.reservations" :class="noticeClass(notice.reservations)" :role="notice.reservations.ok ? 'status' : 'alert'">{{ notice.reservations.text }}</p>
                </form>
            </section>

            <section class="panel" aria-labelledby="mcp-audit-heading">
                <div class="panel-bar">
                    <h2 id="mcp-audit-heading" class="panel-title"><InterfaceIcon name="logs" />{{ $t("mcpAudit") }}</h2>
                    <button type="button" class="btn btn-sm btn-normal" :disabled="loading || busy" @click="load(false)">
                        <InterfaceIcon name="refresh" />{{ $t("mcpRefresh") }}
                    </button>
                </div>

                <div class="panel-body">
                    <p class="form-text">{{ $t("mcpAuditHint") }}</p>
                </div>

                <div v-if="!audit.length" class="panel-body">
                    <p class="form-text">{{ $t("mcpNoAudit") }}</p>
                </div>

                <ul v-else class="panel-rows audit">
                    <li v-for="entry in audit" :key="entry.id" class="panel-row audit-row">
                        <div class="row-main">
                            <span class="row-name">{{ eventName(entry) }}</span>
                            <span class="row-meta">{{ entryLine(entry) }}</span>
                            <span v-if="entry.reason" class="row-meta">{{ reasonText(entry) }}</span>
                        </div>
                        <StateChip compact :state="outcomeState(entry.outcome)" :label="$t(`mcpOutcome_${entry.outcome}`)" />
                    </li>
                </ul>
            </section>
        </template>
    </div>
</template>

<script>
import { MCP_ACTIONS } from "../../../../common/mcp";
import StateChip from "../StateChip.vue";
import { errorText } from "../../util-frontend";

const LOOPBACK = [ "localhost", "127.0.0.1", "[::1]" ];
const CONNECTIONS = [ "initialize", "server/discover" ];
const TOOLS = [ "servers_list", "stacks_list", "containers_list", "container_status", "stability_get", "container_logs", "stack_files_read", "git_preview_result", "operation_prepare", "operation_apply", "operation_status" ];
const OWNER_EVENTS = [ "key_issue", "key_reduce", "key_revoke", "stack_reserve", "stack_unreserve", "operation_approve" ];
const KEY_VARIABLE = "DOCKGE_MCP_KEY";
const PROTOCOL = "2026-07-28";
const DISCOVER = { jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "curl",
            version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {} } } };
const VSCODE_KEY_INPUT = { type: "promptString",
    id: "dockge2-key",
    description: "Dockge2 MCP key",
    password: true };

/**
 * Whether the page talks to the backend on the development port
 * @returns {boolean} True for `npm run dev`
 */
function developmentBackend() {
    let dev = process.env.NODE_ENV === "development";
    try {
        dev ||= localStorage.dev === "dev";
    } catch { /* Storage can be unavailable. */ }
    return dev;
}

export default {
    components: { StateChip },
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
            loadFailed: false,
            loadDenied: false,
            password: "",
            secret: "",
            client: "claude-code",
            notice: { config: null,
                form: null,
                keys: null,
                pending: null,
                reservations: null },
            config: { enabled: false,
                url: "",
                allowInsecureHttp: false },
            saved: { enabled: false,
                url: "",
                allowInsecureHttp: false },
            status: { lastConnection: null,
                lastRefusal: null },
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
        /** Where the backend answers: the development port under `npm run dev`, otherwise this page */
        apiBase() {
            return developmentBackend() ? `${location.protocol}//${location.hostname}:5001` : location.origin;
        },
        pageHost() {
            return new URL(this.apiBase).host;
        },
        suggestedURL() {
            return `${this.apiBase}/mcp`;
        },
        urlInfo() {
            try {
                const url = new URL(this.config.url);
                return { host: url.host,
                    insecure: url.protocol === "http:" && !LOOPBACK.includes(url.hostname) };
            } catch {
                return { host: "",
                    insecure: false };
            }
        },
        /** The server accepts a request only for the host of the configured address */
        hostMismatch() {
            return Boolean(this.urlInfo.host) && this.urlInfo.host !== this.pageHost;
        },
        encryption() {
            try {
                const url = new URL(this.saved.url);
                if (url.protocol === "https:") {
                    return "https";
                }
                return LOOPBACK.includes(url.hostname) ? "loopback" : "insecure";
            } catch {
                return "";
            }
        },
        stateChip() {
            if (!this.saved.enabled) {
                return { state: "stopped",
                    label: this.$t("mcpStateOff"),
                    attention: false };
            }
            const insecure = this.encryption === "insecure";
            return { state: insecure ? "attention" : "running",
                label: this.$t("mcpStateOn"),
                attention: insecure };
        },
        activeKeys() {
            return this.keys.filter((key) => !key.revoked_at && Number(key.expires_at) > Date.now()).length;
        },
        reservations() {
            return this.stacks.filter((stack) => stack.reserved);
        },
        clients() {
            return [
                { id: "claude-code",
                    label: this.$t("mcpClientClaudeCommand") },
                { id: "claude-project",
                    label: this.$t("mcpClientClaudeProject") },
                { id: "cursor",
                    label: "Cursor" },
                { id: "vscode",
                    label: "VS Code" },
                { id: "codex",
                    label: "Codex CLI" },
                { id: "gemini",
                    label: "Gemini CLI" },
                { id: "curl",
                    label: this.$t("mcpClientCurl") },
            ];
        },
        /** Ready-made configuration for the chosen client; the key stays in an environment variable */
        snippet() {
            const url = this.saved.url;
            const json = (value) => JSON.stringify(value, null, 2);
            const file = (name) => this.$t("mcpSnippetFile", { file: name });
            switch (this.client) {
                case "claude-project":
                    return { where: file(".mcp.json"),
                        text: json({ mcpServers: { dockge2: { type: "http",
                            url,
                            headers: { Authorization: `Bearer \${${KEY_VARIABLE}}` } } } }) };
                case "cursor":
                    return { where: file("~/.cursor/mcp.json"),
                        text: json({ mcpServers: { dockge2: { url,
                            headers: { Authorization: `Bearer \${env:${KEY_VARIABLE}}` } } } }) };
                case "vscode":
                    return { where: file(".vscode/mcp.json"),
                        hint: this.$t("mcpSnippetPrompt"),
                        text: json({ inputs: [ VSCODE_KEY_INPUT ],
                            servers: { dockge2: { type: "http",
                                url,
                                headers: { Authorization: "Bearer ${input:dockge2-key}" } } } }) };
                case "codex":
                    return { where: file("~/.codex/config.toml"),
                        text: `[mcp_servers.dockge2]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "${KEY_VARIABLE}"` };
                case "gemini":
                    return { where: file("~/.gemini/settings.json"),
                        text: json({ mcpServers: { dockge2: { httpUrl: url,
                            headers: { Authorization: `Bearer $${KEY_VARIABLE}` } } } }) };
                case "curl":
                    return { where: this.$t("mcpSnippetCommand"),
                        hint: this.$t("mcpSnippetCheckHint"),
                        text: [ `curl -sS ${JSON.stringify(url)} \\`,
                            `  -H "Authorization: Bearer $${KEY_VARIABLE}" \\`,
                            "  -H \"Content-Type: application/json\" \\",
                            "  -H \"Accept: application/json, text/event-stream\" \\",
                            `  -H "MCP-Protocol-Version: ${PROTOCOL}" \\`,
                            "  -H \"Mcp-Method: server/discover\" \\",
                            `  -d '${JSON.stringify(DISCOVER)}'` ].join("\n") };
                default:
                    return { where: this.$t("mcpSnippetCommand"),
                        text: `claude mcp add --transport http dockge2 ${JSON.stringify(url)} \\\n  --header "Authorization: Bearer $${KEY_VARIABLE}"` };
            }
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        async request(path = "", data) {
            const response = await fetch(`${this.apiBase}/api/mcp${path}`, { credentials: "include",
                method: data ? "POST" : "GET",
                headers: data ? { "Content-Type": "application/json" } : {},
                body: data ? JSON.stringify({ password: this.password,
                    data }) : undefined });
            if (!response.ok) {
                let code = "mcpRequestFailed";
                try {
                    code = (await response.json())?.error || code;
                } catch { /* Not every failure has a JSON body. */ }
                const failure = new Error(code);
                failure.status = response.status;
                throw failure;
            }
            return response.json();
        },
        /**
         * Read the section. The settings form is refilled only on the first read and after
         * saving it, so refreshing the list does not discard what the owner is typing.
         * @param {boolean} resetForm Replace the settings form with the saved values
         * @returns {Promise<void>}
         */
        async load(resetForm = true) {
            this.loading = this.loadFailed || !this.users.length;
            try {
                const data = await this.request();
                this.peers = data.peers;
                this.pending = data.pending;
                this.keys = data.keys;
                this.stacks = data.stacks;
                this.users = data.users;
                this.status = data.status;
                this.audit = data.audit;
                this.saved = { enabled: data.config.enabled,
                    url: data.config.configured ? data.config.url : "",
                    allowInsecureHttp: data.config.allowInsecureHttp };
                if (resetForm) {
                    this.config = { enabled: data.config.enabled,
                        url: data.config.url || this.suggestedURL,
                        allowInsecureHttp: data.config.allowInsecureHttp };
                }
                this.form.userId ||= this.users[0]?.id || "";
                this.loadFailed = false;
                this.loadDenied = false;
            } catch (failure) {
                // A failed read is not a refused action; a denial is named separately, because
                // keys belong to an account the server cannot see without a session
                this.loadFailed = true;
                this.loadDenied = failure?.status === 403;
            } finally {
                this.loading = false;
            }
        },
        /**
         * Send one owner action and report its result in the panel it came from
         * @param {string} action Endpoint action
         * @param {object} data Payload
         * @param {string} panel Where the result is shown
         * @param {string} [success] Text shown on success
         * @returns {Promise<object | null>} The answer, or null on failure
         */
        async mutate(action, data, panel, success = "") {
            this.busy = true;
            for (const name of Object.keys(this.notice)) {
                this.notice[name] = null;
            }
            try {
                const result = await this.request(`/${action}`, data);
                await this.load(action === "config");
                if (success) {
                    this.notice[panel] = { ok: true,
                        text: success };
                }
                return result;
            } catch (failure) {
                const code = failure instanceof Error ? failure.message : "";
                this.notice[panel] = { ok: false,
                    text: this.$te(`mcpError_${code}`) ? this.$t(`mcpError_${code}`) : this.$t("mcpError") };
                return null;
            } finally {
                this.busy = false;
            }
        },
        noticeClass(notice) {
            return notice.ok ? "mcp-notice mcp-notice-ok" : "alert alert-danger";
        },
        async saveConfig() {
            const value = { ...this.config,
                allowInsecureHttp: this.urlInfo.insecure && this.config.allowInsecureHttp };
            await this.mutate("config", value, "config", value.enabled ? this.$t("mcpSavedOn", { url: value.url }) : this.$t("mcpSavedOff"));
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
            const reducing = Boolean(this.editing);
            const result = await this.mutate(reducing ? "reduce" : "issue", reducing ? { id: this.editing,
                value } : value, "form");
            if (result) {
                this.secret = result.secret || "";
                this.cancelEdit();
                if (reducing) {
                    this.notice.keys = { ok: true,
                        text: this.$t("mcpReducedDone") };
                }
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
            return this.$te(`mcpAction_${action}`) ? this.$t(`mcpAction_${action}`) : String(action ?? "");
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
            const name = this.reserveName;
            if (await this.mutate("reserve", { name }, "reservations", this.$t("mcpReservedDone", { name }))) {
                this.reserveName = "";
            }
        },
        unreserve(stack) {
            return this.mutate("unreserve", { id: stack.id }, "reservations", this.$t("mcpUnreservedDone", { name: stack.name }));
        },
        async review(operation) {
            const value = await this.mutate("review", { id: operation.operation_id }, "pending");
            if (value) {
                this.reviewed = { operation,
                    value };
            }
        },
        async approve() {
            if (await this.mutate("approve", { id: this.reviewed.operation.operation_id }, "pending", this.$t("mcpApprovedDone"))) {
                this.reviewed = null;
            }
        },
        revoke(id) {
            return this.mutate("revoke", { id }, "keys", this.$t("mcpRevokedDone"));
        },
        async copy(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.$root.toastSuccess(this.$t("copiedToClipboard"));
            } catch (error) {
                this.$root.toastError(errorText(error));
            }
        },
        /**
         * A readable resource name: the stack name on this server, prefixed with the
         * server name elsewhere, so equal names can be told apart
         * @param {string} server Server ID
         * @param {string} id Stack ID
         * @returns {string} Readable name
         */
        resourceName(server, id) {
            const stack = this.stacks.find((item) => item.id === id)?.name || id;

            if (!server || server === "local") {
                return stack;
            }

            return `${this.peers.find((peer) => peer.id === server)?.name || server}: ${stack}`;
        },
        formatDate(value) {
            return value ? new Date(Number(value)).toLocaleString() : "-";
        },
        /**
         * A key's scope is stored as "server|stack" pairs; readers need names
         * @param {string} value Scope list as JSON
         * @returns {string} Stack names, comma separated
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
        reservationKeys(id) {
            const names = this.keys
                .filter((key) => !key.revoked_at && (JSON.parse(key.resources).local || []).includes(id))
                .map((key) => key.name);
            return names.length ? this.$t("mcpReservationKeys", { keys: names.join(", ") }) : this.$t("mcpReservationUnused");
        },
        keyName(id) {
            return id ? this.keys.find((key) => key.id === id)?.name || id.slice(0, 8) : "";
        },
        eventName(entry) {
            const tool = entry.tool;
            if (CONNECTIONS.includes(tool)) {
                return this.$t("mcpEvent_connect");
            }
            if (tool === "tools/list") {
                return this.$t("mcpEvent_list");
            }
            if (TOOLS.includes(tool)) {
                return this.$t("mcpEvent_call", { tool });
            }
            if (tool === "config_update") {
                return this.$t(entry.detail === "enabled" ? "mcpEvent_config_enabled" : "mcpEvent_config_disabled");
            }
            if (tool === "request" || OWNER_EVENTS.includes(tool)) {
                return this.$t(`mcpEvent_${tool}`, { name: entry.detail || "",
                    action: this.actionName(entry.action) });
            }
            return this.$t("mcpEvent_unknown");
        },
        /**
         * Time, key, client, stack, address and repeats of one log row, whichever it has
         * @param {object} entry Log row
         * @returns {string} One line
         */
        entryLine(entry) {
            const client = entry.client_name ? [ entry.client_name, entry.client_version, entry.protocol_version && `(${entry.protocol_version})` ].filter(Boolean).join(" ") : "";
            const stack = entry.stack_id && ![ "stack_reserve", "stack_unreserve" ].includes(entry.tool) ? this.resourceName(entry.server_id, entry.stack_id) : "";
            return [
                this.formatDate(entry.at),
                this.keyName(entry.key_id),
                client,
                stack,
                entry.address,
                entry.attempts > 1 ? this.$t("mcpAttempts", { count: entry.attempts }) : "",
                entry.detail === "delegated" ? this.$t("mcpDelegated") : "",
            ].filter(Boolean).join(" · ");
        },
        reasonText(entry) {
            const key = `mcpReason_${entry.reason}`;
            return this.$te(key) ? this.$t(key, { detail: entry.detail || "?" }) : String(entry.reason ?? "");
        },
        outcomeState(outcome) {
            return { allowed: "running",
                invalid: "attention",
                denied: "failed",
                refused: "failed" }[outcome] || "unknown";
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

.mcp-status {
    display: grid;
    gap: var(--gap-sm);
    margin: 0;

    > div {
        display: grid;
        grid-template-columns: minmax(10rem, 14rem) minmax(0, 1fr);
        gap: var(--gap-md);
    }

    dt {
        color: var(--text-muted);
        font-size: var(--text-sm);
        font-weight: var(--weight-regular);
    }

    dd {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin: 0;
        color: var(--text-strong);
        font-size: var(--text-sm);
        overflow-wrap: anywhere;
    }

    code {
        font-size: var(--text-code);
    }
}

.status-warning {
    color: var(--state-attention);
    font-weight: var(--weight-medium);
}

.status-reason {
    color: var(--text-muted);
}

.mcp-notice {
    margin: 0;
    font-size: var(--text-sm);
}

.mcp-notice-ok {
    color: var(--state-running);
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

.audit {
    margin: 0;
    padding: 0;
    list-style: none;
}

// Shown once: a separate band, monospace so every character reads unambiguously
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

// Commands keep their lines: a wrapped shell line reads as two commands
.mcp-snippet {
    margin: 0;
    white-space: pre;
    overflow-wrap: normal;
}

@media (max-width: 700px) {
    .mcp-comparison,
    .mcp-status > div {
        grid-template-columns: minmax(0, 1fr);
    }

    .mcp-status > div {
        gap: 2px;
    }
}
</style>
