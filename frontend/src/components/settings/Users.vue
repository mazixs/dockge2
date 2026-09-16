<template>
    <!-- Пользователи: панель со списком, правка открывается отдельной панелью над
         списком. Роль и доступ названы словом, состояние - тем же чипом, что у стека -->
    <div class="users">
        <p v-if="error" class="alert alert-danger" role="alert">{{ $t(error) }}</p>
        <p v-if="message" class="alert alert-success" role="status">{{ $t(message) }}</p>

        <section v-if="mode" class="panel">
            <div class="panel-bar">
                <h2 class="panel-title"><InterfaceIcon name="users" />{{ mode === "create" ? $t("usersAdd") : selected?.name }}</h2>
            </div>

            <form v-if="mode === 'create'" class="panel-body form-stack" @submit.prevent="create">
                <div class="user-fields">
                    <div class="field">
                        <label for="user-username" class="form-label">{{ $t("authUsername") }}</label>
                        <input id="user-username" v-model="form.username" class="form-control" autocomplete="off" pattern="[a-zA-Z0-9_.]{3,30}" required :disabled="busy">
                    </div>
                    <div class="field">
                        <label for="user-email" class="form-label">{{ $t("Email") }}</label>
                        <input id="user-email" v-model="form.email" class="form-control" type="email" autocomplete="off" required :disabled="busy">
                    </div>
                    <div class="field">
                        <label for="user-name" class="form-label">{{ $t("usersDisplayName") }}</label>
                        <input id="user-name" v-model="form.name" class="form-control" maxlength="100" :disabled="busy">
                    </div>
                    <div class="field">
                        <label for="user-password" class="form-label">{{ $t("Password") }}</label>
                        <input id="user-password" v-model="form.password" class="form-control" type="password" autocomplete="new-password" minlength="10" maxlength="128" required :disabled="busy">
                    </div>
                    <div class="field">
                        <label for="user-role" class="form-label">{{ $t("usersRole") }}</label>
                        <select id="user-role" v-model="form.role" class="form-select" :disabled="busy">
                            <option v-for="role in roles" :key="role" :value="role">{{ $t(`usersRole_${role}`) }}</option>
                        </select>
                    </div>
                </div>
                <p class="form-text">{{ $t("authUsernameHint") }} {{ $t("usersRoleHint") }}</p>
                <div class="actions">
                    <button class="btn btn-primary" :disabled="busy">{{ $t("Create") }}</button>
                    <button type="button" class="btn btn-normal" :disabled="busy" @click="closeEditor">{{ $t("cancel") }}</button>
                </div>
            </form>

            <form v-else-if="mode === 'password'" class="panel-body form-stack" @submit.prevent="resetPassword">
                <div class="field">
                    <label for="user-new-password" class="form-label">{{ $t("New Password") }}</label>
                    <input id="user-new-password" v-model="form.password" class="form-control" type="password" autocomplete="new-password" minlength="10" maxlength="128" required :disabled="busy">
                    <p class="form-text">{{ $t("usersResetHint") }}</p>
                </div>
                <div class="actions">
                    <button class="btn btn-primary" :disabled="busy">{{ $t("usersResetPassword") }}</button>
                    <button type="button" class="btn btn-normal" :disabled="busy" @click="closeEditor">{{ $t("cancel") }}</button>
                </div>
            </form>

            <form v-else-if="mode === 'access'" class="panel-body form-stack" @submit.prevent="saveAccess">
                <div class="field">
                    <label for="user-access-role" class="form-label">{{ $t("usersRole") }}</label>
                    <select id="user-access-role" v-model="form.role" class="form-select" :disabled="busy">
                        <option v-for="role in roles" :key="role" :value="role">{{ $t(`usersRole_${role}`) }}</option>
                    </select>
                    <p class="form-text">{{ $t("usersAccessHint") }}</p>
                </div>
                <label class="form-check">
                    <input v-model="form.suspended" type="checkbox" class="form-check-input" :disabled="busy">
                    <span class="form-check-label">{{ $t("usersSuspend") }}</span>
                </label>
                <div class="actions">
                    <button class="btn btn-primary" :disabled="busy">{{ $t("Save") }}</button>
                    <button type="button" class="btn btn-normal" :disabled="busy" @click="closeEditor">{{ $t("cancel") }}</button>
                </div>
            </form>

            <div v-else-if="mode === 'delete'" class="panel-body form-stack">
                <p class="form-text">{{ $t("usersDeleteHint", { name: selected?.username || selected?.email }) }}</p>
                <div class="actions">
                    <button class="btn btn-danger" :disabled="busy" @click="remove">{{ $t("usersDelete") }}</button>
                    <button class="btn btn-normal" :disabled="busy" @click="closeEditor">{{ $t("cancel") }}</button>
                </div>
            </div>
        </section>

        <section class="panel" aria-labelledby="users-heading">
            <div class="panel-bar">
                <h2 id="users-heading" class="panel-title"><InterfaceIcon name="users" />{{ $t("usersTitle") }}</h2>
                <span v-if="!loading" class="panel-meta">{{ users.length }}</span>
                <button class="btn btn-sm btn-primary" :disabled="busy" @click="openCreate">
                    <font-awesome-icon icon="plus" />{{ $t("usersAdd") }}
                </button>
            </div>

            <div v-if="loading" class="panel-body">
                <p class="form-text" role="status">{{ $t("loading") }}</p>
            </div>

            <div v-else-if="error" class="panel-body">
                <button class="btn btn-sm btn-normal" @click="load">{{ $t("usersRetry") }}</button>
            </div>

            <div v-else class="panel-rows">
                <div v-for="user in users" :key="user.id" class="panel-row user-row">
                    <div class="user-identity">
                        <span class="user-name">{{ user.name }}<span v-if="user.id === $root.userID" class="user-you">{{ $t("usersYou") }}</span></span>
                        <span class="user-login">{{ user.username || user.email }}</span>
                    </div>

                    <span class="user-role">{{ $t(`usersRole_${user.role}`) }}</span>

                    <StateChip
                        :state="user.suspended ? 'stopped' : 'running'"
                        :label="$t(user.suspended ? 'usersSuspended' : 'usersActive')"
                        compact
                    />

                    <div class="actions">
                        <button class="btn btn-sm btn-normal" :disabled="busy" @click="edit(user, 'access')">{{ $t("usersEditAccess") }}</button>
                        <button class="btn btn-sm btn-normal" :disabled="busy" @click="edit(user, 'password')">{{ $t("usersResetPassword") }}</button>
                        <button class="btn btn-sm btn-normal btn-danger-text" :disabled="busy || user.id === lastOwnerId" @click="edit(user, 'delete')">{{ $t("usersDelete") }}</button>
                    </div>
                </div>
            </div>

            <!-- Подпись говорит и о том, почему у одной строки удаление выключено:
                 сервер откажет последнему владельцу, и кнопка, которая всегда
                 кончается ошибкой, обещает действие, которого нет. Обе фразы -
                 один текст: вторым элементом строки они встали бы в две колонки -->
            <p class="panel-foot"><font-awesome-icon icon="info-circle" /><span>{{ hint }}</span></p>
        </section>
    </div>
</template>

<script>
import StateChip from "../StateChip.vue";
import InterfaceIcon from "../InterfaceIcon.vue";

export default {
    components: { StateChip,
        InterfaceIcon },
    data() {
        return {
            users: [],
            loading: true,
            busy: false,
            error: "",
            message: "",
            mode: "",
            selected: null,
            roles: [ "viewer", "operator", "admin" ],
            form: { username: "",
                name: "",
                email: "",
                password: "",
                role: "viewer",
                suspended: false },
        };
    },
    computed: {
        /**
         * Единственный действующий владелец: его удалить нельзя, и сервер это
         * проверяет сам. Пока он один, кнопка удаления у его строки выключена
         * @returns {string} Идентификатор такого владельца или пустая строка
         */
        lastOwnerId() {
            const owners = this.users.filter((user) => user.role === "admin" && !user.suspended);
            return owners.length === 1 ? owners[0].id : "";
        },

        /** Подпись панели: откуда берутся учетные записи и почему одна из них несносима */
        hint() {
            const parts = [ this.$t("usersHint") ];

            if (this.lastOwnerId) {
                parts.push(this.$t("usersLastOwnerHint"));
            }

            return parts.join(" ");
        },
    },
    mounted() {
        this.load();
    },
    methods: {
        /** Bound socket requests so a lost connection cannot leave an endless spinner. */
        request(event, data) {
            return new Promise((resolve, reject) => {
                const callback = (error, result) => {
                    if (error || !result?.ok) {
                        reject(new Error(error ? "authConnectionFailed" : result?.msg || "authUnknownError"));
                    } else {
                        resolve(result);
                    }
                };
                const socket = this.$root.getSocket().timeout(10000);
                if (data === undefined) {
                    socket.emit(event, callback);
                } else {
                    socket.emit(event, data, callback);
                }
            });
        },
        async load() {
            this.loading = true;
            this.error = "";
            try {
                const result = await this.request("usersList");
                this.users = result.users;
            } catch (error) {
                this.error = error.message;
            } finally {
                this.loading = false;
            }
        },
        closeEditor() {
            this.mode = "";
            this.selected = null;
            this.form.password = "";
        },
        openCreate() {
            this.form = { username: "",
                name: "",
                email: "",
                password: "",
                role: "viewer",
                suspended: false };
            this.selected = null;
            this.mode = "create";
            this.message = "";
        },
        edit(user, mode) {
            this.selected = user;
            this.form = { ...user,
                password: "",
                suspended: Boolean(user.suspended) };
            this.mode = mode;
            this.message = "";
        },
        async apply(event, data) {
            this.busy = true;
            this.error = "";
            this.message = "";
            try {
                await this.request(event, data);
                this.closeEditor();
                this.message = "usersSaved";
                await this.load();
            } catch (error) {
                this.error = error.message;
            } finally {
                this.busy = false;
            }
        },
        create() {
            return this.apply("usersCreate", this.form);
        },
        saveAccess() {
            return this.apply("usersUpdate", { id: this.selected.id,
                role: this.form.role,
                suspended: this.form.suspended });
        },
        resetPassword() {
            return this.apply("usersResetPassword", { id: this.selected.id,
                password: this.form.password });
        },
        remove() {
            return this.apply("usersDelete", { id: this.selected.id });
        },
    },
};
</script>

<style scoped lang="scss">
.users {
    display: flex;
    flex-direction: column;
    gap: var(--gap-lg);
}

.alert {
    margin: 0;
}

// Два поля в ряд на широком экране: анкета не растягивается в столбик на экран
.user-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--gap-md);
}

.user-identity {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 10rem;
    overflow-wrap: anywhere;
}

.user-name {
    display: flex;
    align-items: baseline;
    gap: var(--gap-sm);
    color: var(--text-strong);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
}

.user-you {
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
}

.user-login {
    color: var(--text-faint);
    font-size: var(--text-xs);
    line-height: var(--line-xs);
}

.user-role {
    color: var(--text-muted);
    font-size: var(--text-sm);
}

@media (max-width: 600px) {
    .user-fields {
        grid-template-columns: minmax(0, 1fr);
    }

    .user-row .actions {
        width: 100%;
    }
}
</style>
