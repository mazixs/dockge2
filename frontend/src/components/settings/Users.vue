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

            <!-- Every change asks for the password of the owner making it: an unattended
                 signed-in browser must not be enough to hand out or take away access -->
            <form class="panel-body form-stack" @submit.prevent="submit">
                <template v-if="mode === 'create'">
                    <div class="user-fields">
                        <div class="field">
                            <label for="user-username" class="form-label">{{ $t("authUsername") }}</label>
                            <input id="user-username" v-model="form.username" class="form-control" autocomplete="off" pattern="[a-zA-Z0-9_.]{3,30}" required :disabled="busy">
                        </div>
                        <div class="field">
                            <label for="user-email" class="form-label">{{ $t("email") }}</label>
                            <input id="user-email" v-model="form.email" class="form-control" type="email" autocomplete="off" required :disabled="busy">
                        </div>
                        <div class="field">
                            <label for="user-name" class="form-label">{{ $t("usersDisplayName") }}</label>
                            <input id="user-name" v-model="form.name" class="form-control" maxlength="100" :disabled="busy">
                        </div>
                        <div class="field">
                            <label for="user-password" class="form-label">{{ $t("password") }}</label>
                            <input id="user-password" v-model="form.password" class="form-control" type="password" autocomplete="new-password" minlength="10" maxlength="128" required :disabled="busy">
                        </div>
                        <div class="field">
                            <label for="user-role" class="form-label">{{ $t("usersRole") }}</label>
                            <select id="user-role" v-model="form.role" class="form-select" :disabled="busy">
                                <option v-for="role in roles" :key="role" :value="role">{{ $t(`usersRole_${role}`) }}</option>
                            </select>
                        </div>
                    </div>
                    <ul class="form-hints">
                        <li>{{ $t("authUsernameHint") }}</li>
                        <li>{{ $t("usersRoleHint") }}</li>
                    </ul>
                </template>

                <div v-else-if="mode === 'password'" class="field">
                    <label for="user-new-password" class="form-label">{{ $t("newPassword") }}</label>
                    <input id="user-new-password" v-model="form.password" class="form-control" type="password" autocomplete="new-password" minlength="10" maxlength="128" required :disabled="busy">
                    <p class="form-text">{{ $t("usersResetHint") }}</p>
                </div>

                <template v-else-if="mode === 'access'">
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
                </template>

                <p v-else class="form-text">{{ $t("usersDeleteHint", { name: selected?.username || selected?.email }) }}</p>

                <div class="field">
                    <label for="user-confirm-password" class="form-label">{{ $t("usersYourPassword") }}</label>
                    <input id="user-confirm-password" v-model="confirmPassword" class="form-control" type="password" autocomplete="current-password" required :disabled="busy">
                </div>

                <div class="actions">
                    <button class="btn" :class="mode === 'delete' ? 'btn-danger' : 'btn-primary'" :disabled="busy">{{ $t(submitLabel) }}</button>
                    <button type="button" class="btn btn-normal" :disabled="busy" @click="closeEditor">{{ $t("cancel") }}</button>
                </div>
            </form>
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

<script lang="ts">
import { defineComponent } from "vue";
import StateChip from "../StateChip.vue";
import InterfaceIcon from "../InterfaceIcon.vue";

type UserRole = "viewer" | "operator" | "admin";

/** What the open editor does */
type EditorMode = "" | "create" | "password" | "access" | "delete";

/** An account as the list shows it; SQLite answers the switch as 0 or 1 */
interface UserRow {
    id : string;
    name : string;
    email : string;
    username : string | null;
    role : UserRole;
    suspended : boolean | number;
    twoFactorEnabled? : boolean | number;
}

/** What the editor changes */
interface UserForm {
    username : string | null;
    name : string;
    email : string;
    password : string;
    role : UserRole;
    suspended : boolean;
}

/** The answer of a users request */
interface UsersAnswer {
    ok? : boolean;
    msg? : string;
}

/**
 * Catalogue key of a failed request
 * @param error What the request was rejected with
 * @returns The key to show
 */
function errorKey(error : unknown) : string {
    return error instanceof Error ? error.message : String(error);
}

export default defineComponent({
    components: { StateChip,
        InterfaceIcon },
    data() {
        return {
            users: [] as UserRow[],
            loading: true,
            busy: false,
            error: "",
            message: "",
            mode: "" as EditorMode,
            selected: null as UserRow | null,
            confirmPassword: "",
            roles: [ "viewer", "operator", "admin" ] as UserRole[],
            form: { username: "",
                name: "",
                email: "",
                password: "",
                role: "viewer",
                suspended: false } as UserForm,
        };
    },
    computed: {
        /**
         * Единственный действующий владелец: его удалить нельзя, и сервер это
         * проверяет сам. Пока он один, кнопка удаления у его строки выключена
         * @returns Идентификатор такого владельца или пустая строка
         */
        lastOwnerId() : string {
            const owners = this.users.filter((user) => user.role === "admin" && !user.suspended);
            return owners.length === 1 ? owners[0]?.id ?? "" : "";
        },

        /** Label of the button that applies the open editor */
        submitLabel() : string {
            const labels : Record<string, string> = { create: "create",
                password: "usersResetPassword",
                access: "save",
                delete: "usersDelete" };
            return labels[this.mode] ?? "save";
        },

        /** Подпись панели: откуда берутся учетные записи и почему одна из них несносима */
        hint() : string {
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
        /**
         * Bound socket requests so a lost connection cannot leave an endless spinner.
         * @param event Event name
         * @param data Payload
         * @param currentPassword Password of the owner, for a change
         * @returns The answer
         */
        request<R extends object = UsersAnswer>(event : string, data? : object, currentPassword? : string) : Promise<R> {
            return new Promise((resolve, reject) => {
                const callback = (error : Error | null, result? : UsersAnswer) => {
                    if (error || !result?.ok) {
                        reject(new Error(error ? "authConnectionFailed" : result?.msg || "authUnknownError"));
                    } else {
                        resolve(result as R);
                    }
                };
                const socket = this.$root.getSocket().timeout(10000);
                if (data === undefined) {
                    socket.emit(event, callback);
                } else {
                    socket.emit(event, data, currentPassword, callback);
                }
            });
        },
        async load() {
            this.loading = true;
            this.error = "";
            try {
                const result = await this.request<{ users : UserRow[] }>("usersList");
                this.users = result.users;
            } catch (error) {
                this.error = errorKey(error);
            } finally {
                this.loading = false;
            }
        },
        closeEditor() {
            this.mode = "";
            this.selected = null;
            this.form.password = "";
            this.confirmPassword = "";
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
        edit(user : UserRow, mode : EditorMode) {
            this.selected = user;
            this.form = { ...user,
                password: "",
                suspended: Boolean(user.suspended) };
            this.mode = mode;
            this.message = "";
        },
        async apply(event : string, data : object) {
            this.busy = true;
            this.error = "";
            this.message = "";
            try {
                await this.request(event, data, this.confirmPassword);
                this.closeEditor();
                this.message = "usersSaved";
                await this.load();
            } catch (error) {
                this.error = errorKey(error);
                this.confirmPassword = "";
            } finally {
                this.busy = false;
            }
        },
        submit() {
            const actions : Record<string, () => Promise<void> | undefined> = { create: this.create,
                password: this.resetPassword,
                access: this.saveAccess,
                delete: this.remove };
            return actions[this.mode]?.();
        },
        create() {
            return this.apply("usersCreate", this.form);
        },
        saveAccess() {
            if (!this.selected) {
                return;
            }
            return this.apply("usersUpdate", { id: this.selected.id,
                role: this.form.role,
                suspended: this.form.suspended });
        },
        resetPassword() {
            if (!this.selected) {
                return;
            }
            return this.apply("usersResetPassword", { id: this.selected.id,
                password: this.form.password });
        },
        remove() {
            if (!this.selected) {
                return;
            }
            return this.apply("usersDelete", { id: this.selected.id });
        },
    },
});
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

// Подсказки формы - список, а не абзац: две разные мысли подряд сливались
// в одну фразу без начала и конца
.form-hints {
    margin: 0;
    padding-left: var(--gap-lg);
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
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
    font-size: var(--text-sm);
    font-weight: var(--weight-regular);
}

.user-login {
    color: var(--text-faint);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
}

// Роль - бирка рядом с бирой доступа: два свойства одного человека читаются
// парой, а не надписью и значком разного вида
.user-role {
    padding: 0 var(--gap-sm);
    border: 1px solid var(--line-hair);
    border-radius: var(--radius-pill);
    background-color: var(--surface-raised);
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--control-height-sm);
    white-space: nowrap;
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
