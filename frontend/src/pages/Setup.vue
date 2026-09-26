<template>
    <!-- Первый запуск: та же карточка, что у входа. Поля идут в том порядке,
         в каком их заполняют: сначала язык, потом ключ, потом сама запись -->
    <div class="auth-screen" data-cy="setup-form">
        <div class="auth-card">
            <div class="auth-brand">
                <object width="32" height="32" data="/icon.svg" aria-hidden="true" />
                <BrandMark />
            </div>

            <div class="auth-head">
                <h1>{{ $t("setupTitle") }}</h1>
                <p class="auth-lede">{{ $t("setupHint") }}</p>
            </div>

            <form class="auth-form form-stack" @submit.prevent="submit">
                <div class="field">
                    <label for="setup-language" class="form-label">{{ $t("language") }}</label>
                    <select id="setup-language" v-model="$root.language" class="form-select">
                        <option v-for="language in availableLanguages" :key="language.code" :value="language.code">
                            {{ language.name }}
                        </option>
                    </select>
                </div>

                <div class="field">
                    <label for="bootstrap-token" class="form-label">{{ $t("authBootstrapToken") }}</label>
                    <input id="bootstrap-token" v-model="token" type="password" class="form-control" autocomplete="off" required :disabled="processing">
                    <p class="form-text">{{ $t("authBootstrapHint") }}</p>
                </div>

                <div class="field">
                    <label for="setup-username" class="form-label">{{ $t("authUsername") }}</label>
                    <input id="setup-username" v-model="username" type="text" class="form-control" autocomplete="username" pattern="[a-zA-Z0-9_.]{3,30}" required :disabled="processing">
                    <p class="form-text">{{ $t("authUsernameHint") }}</p>
                </div>

                <div class="field">
                    <label for="setup-email" class="form-label">{{ $t("email") }}</label>
                    <input id="setup-email" v-model="email" type="email" class="form-control" placeholder="you@example.com" autocomplete="email" required :disabled="processing" data-cy="email-input">
                </div>

                <div class="field">
                    <label for="setup-password" class="form-label">{{ $t("password") }}</label>
                    <input id="setup-password" v-model="password" type="password" class="form-control" autocomplete="new-password" :minlength="minPasswordLength" required :disabled="processing" data-cy="password-input">
                    <p class="form-text">{{ $t("passwordMinLengthHint") }}</p>
                </div>

                <div class="field">
                    <label for="setup-repeat" class="form-label">{{ $t("repeatPassword") }}</label>
                    <input id="setup-repeat" v-model="repeatPassword" type="password" class="form-control" autocomplete="new-password" :minlength="minPasswordLength" required :disabled="processing" data-cy="password-repeat-input">
                </div>

                <button class="btn btn-primary" type="submit" :disabled="processing" data-cy="submit-setup-form">
                    {{ $t("create") }}
                </button>
            </form>
        </div>
    </div>
</template>
<script lang="ts">
import { defineComponent } from "vue";
import BrandMark from "../components/BrandMark.vue";
import { bootstrapOwner } from "../auth-client";
import { authErrorMessage } from "../auth-messages";
import { availableLanguages } from "../i18n";
import type { SocketResponse } from "../mixins/socket";

export default defineComponent({
    components: { BrandMark },
    data() {
        return {
            processing: false,
            email: "",
            username: "",
            token: "",
            password: "",
            repeatPassword: "",
        };
    },
    computed: {
        /**
         * Languages offered in the selector
         * @returns Language code and display name pairs
         */
        availableLanguages() : Array<{ code : string, name : string }> {
            return availableLanguages();
        },

        /**
         * Shortest password the server accepts, mirrored from `backend/auth.ts`
         * @returns {number} Minimum length
         */
        minPasswordLength() : number {
            return 10;
        },
    },
    mounted() {
        // TODO: Check if it is a database setup

        this.$root.getSocket().emit("needsSetup", (res : SocketResponse | undefined) => {
            if (res?.ok && !res.needsSetup) {
                this.$router.push("/");
            }
        });
    },
    methods: {
        /**
         * Submit form data for processing
         * @returns {void}
         */
        async submit() {
            this.processing = true;

            if (this.password !== this.repeatPassword) {
                this.$root.toastError("passwordsDoNotMatch");
                this.processing = false;
                return;
            }

            // Said here as well as by the server, so the answer is immediate
            if (this.password.length < this.minPasswordLength) {
                this.$root.toastError("authPasswordTooShort");
                this.processing = false;
                return;
            }

            try {
                const { error } = await bootstrapOwner({
                    token: this.token,
                    username: this.username,
                    email: this.email,
                    password: this.password,
                    name: this.username,
                });

                if (error) {
                    this.$root.toastError(authErrorMessage(error));
                    return;
                }

                this.token = "";
                const login = await this.$root.signIn(this.username, this.password);
                if (!login.ok) {
                    this.$root.toastError(login.msg ?? "");
                }
                this.$router.push("/");
            } finally {
                this.processing = false;
            }
        },
    },
});
</script>
