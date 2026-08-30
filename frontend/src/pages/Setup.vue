<template>
    <div class="form-container" data-cy="setup-form">
        <div class="form">
            <form @submit.prevent="submit">
                <div class="brand">
                    <object width="48" height="48" data="/icon.svg" aria-hidden="true" />
                    <span class="wordmark">Dockge</span>
                </div>

                <!-- Первый запуск: экран говорит, что здесь заводится, и что заводится один раз -->
                <h1 class="title">{{ $t("setupTitle") }}</h1>
                <p class="hint">{{ $t("setupHint") }}</p>

                <div class="form-floating">
                    <select id="language" v-model="$root.language" class="form-select">
                        <option v-for="language in availableLanguages" :key="language.code" :value="language.code">
                            {{ language.name }}
                        </option>
                    </select>
                    <label for="language" class="form-label">{{ $t("Language") }}</label>
                </div>

                <div class="form-floating mt-3">
                    <input id="floatingInput" v-model="email" type="email" class="form-control" placeholder="you@example.com" autocomplete="username" required data-cy="email-input">
                    <label for="floatingInput">{{ $t("Email") }}</label>
                </div>

                <div class="form-floating mt-3">
                    <input id="floatingPassword" v-model="password" type="password" class="form-control" :placeholder="$t('Password')" autocomplete="new-password" :minlength="minPasswordLength" required data-cy="password-input">
                    <label for="floatingPassword">{{ $t("Password") }}</label>
                </div>
                <p class="form-text text-start">{{ $t("passwordMinLengthHint") }}</p>

                <div class="form-floating mt-3">
                    <input id="repeat" v-model="repeatPassword" type="password" class="form-control" :placeholder="$t('Repeat Password')" autocomplete="new-password" :minlength="minPasswordLength" required data-cy="password-repeat-input">
                    <label for="repeat">{{ $t("Repeat Password") }}</label>
                </div>

                <button class="w-100 btn btn-primary mt-3" type="submit" :disabled="processing" data-cy="submit-setup-form">
                    {{ $t("Create") }}
                </button>
            </form>
        </div>
    </div>
</template>

<script>
import { authClient } from "../auth-client";
import { authErrorMessage } from "../auth-messages";
import { availableLanguages } from "../i18n";

export default {
    data() {
        return {
            processing: false,
            email: "",
            password: "",
            repeatPassword: "",
        };
    },
    computed: {
        /**
         * Languages offered in the selector
         * @returns {Array<object>} Language code and display name pairs
         */
        availableLanguages() {
            return availableLanguages();
        },

        /**
         * Shortest password the server accepts, mirrored from `backend/auth.ts`
         * @returns {number} Minimum length
         */
        minPasswordLength() {
            return 10;
        },
    },
    watch: {

    },
    mounted() {
        // TODO: Check if it is a database setup

        this.$root.getSocket().emit("needsSetup", (res) => {
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
                this.$root.toastError("PasswordsDoNotMatch");
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
                // The account is created through the auth endpoint, which signs the
                // browser in and sets the session cookie in the same request
                const { error } = await authClient.signUp.email({
                    email: this.email,
                    password: this.password,
                    name: this.email,
                });

                if (error) {
                    this.$root.toastError(authErrorMessage(error));
                    return;
                }

                await this.$root.reconnectSocket();
                await this.$root.refreshSession();
                this.$router.push("/");
            } finally {
                this.processing = false;
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.form-container {
    display: flex;
    align-items: center;
    padding-top: 40px;
    padding-bottom: 40px;
}

.form-floating {
    > .form-select {
        padding-left: 1.3rem;
        padding-top: 1.525rem;
        line-height: 1.35;

        ~ label {
            padding-left: 1.3rem;
        }
    }

    > label {
        padding-left: 1.3rem;
    }

    > .form-control {
        padding-left: 1.3rem;
    }
}

.form {

    width: 100%;
    max-width: 330px;
    padding: 15px;
    margin: auto;
    text-align: center;
}

.brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--gap-sm);
}

.wordmark {
    font-size: var(--text-xl);
    font-weight: 600;
    color: var(--text-strong);
}

.title {
    margin: var(--gap-lg) 0 var(--gap-xs);
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--text-strong);
}

// Объяснение в одну строку: почему учётная запись одна и что она значит
.hint {
    margin: 0 0 var(--gap-lg);
    font-size: var(--text-sm);
    color: var(--text-muted);
}
</style>
