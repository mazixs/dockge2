<template>
    <!-- Вход: одна карточка по центру. Второй шаг с кодом заменяет поля, а не
         добавляется под ними - на экране всегда ровно то, что сейчас спрашивают -->
    <div class="auth-screen">
        <div class="auth-card">
            <!-- Марка сверху - та же, что на первом запуске: человек должен видеть,
                 куда он входит, до того как назовет себя -->
            <div class="auth-brand">
                <object width="32" height="32" data="/icon.svg" aria-hidden="true" />
                <BrandMark />
            </div>

            <div class="auth-head">
                <h1>{{ $t(tokenRequired ? "Token" : "Login") }}</h1>
                <p v-if="tokenRequired" class="auth-lede">{{ $t("twoFactorCodeHint") }}</p>
            </div>

            <form class="auth-form form-stack" @submit.prevent="submit">
                <template v-if="!tokenRequired">
                    <div class="field">
                        <label for="login-identifier" class="form-label">{{ $t("authLoginIdentifier") }}</label>
                        <input id="login-identifier" v-model="email" type="text" class="form-control" placeholder="operator" autocomplete="username" :disabled="processing" required>
                    </div>

                    <div class="field">
                        <label for="login-password" class="form-label">{{ $t("Password") }}</label>
                        <input id="login-password" v-model="password" type="password" class="form-control" autocomplete="current-password" :disabled="processing" required>
                    </div>
                </template>

                <!-- Резервный код длиннее кода из приложения, поэтому поле принимает оба -->
                <div v-else class="field">
                    <label for="login-otp" class="form-label">{{ $t("Token") }}</label>
                    <input id="login-otp" ref="otp" v-model="token" type="text" maxlength="16" class="form-control" placeholder="123456" autocomplete="one-time-code" inputmode="numeric" :disabled="processing" required>
                </div>

                <p v-if="res && !res.ok" class="alert alert-danger" role="alert">{{ $t(res.msg) }}</p>

                <button class="btn btn-primary" type="submit" :disabled="processing">
                    <span v-if="processing" class="spinner-border spinner-border-sm"></span>
                    {{ $t("Login") }}
                </button>

                <button v-if="tokenRequired" class="btn btn-normal" type="button" :disabled="processing" @click="restart">
                    {{ $t("backToLogin") }}
                </button>
            </form>
        </div>
    </div>
</template>
<script>
import BrandMark from "./BrandMark.vue";

export default {
    components: { BrandMark },
    data() {
        return {
            processing: false,
            email: "",
            password: "",
            token: "",
            res: null,
            tokenRequired: false,
        };
    },

    mounted() {
        document.title += " - Login";
    },

    unmounted() {
        document.title = document.title.replace(" - Login", "");
    },

    methods: {
        /**
         * Submit the user details and attempt to log in
         * @returns {void}
         */
        async submit() {
            this.processing = true;

            try {
                // Once the challenge is open, only the code is sent: repeating the
                // password would start a new challenge and burn the sign-in rate limit
                const res = this.tokenRequired
                    ? await this.$root.verifyTwoFactor(this.token)
                    : await this.$root.signIn(this.email, this.password);

                if (res.twoFactorRequired) {
                    this.tokenRequired = true;
                    this.token = "";
                    this.res = res.msg ? res : null;

                    await this.$nextTick();
                    this.$refs.otp?.focus();
                    return;
                }

                this.res = res;

                if (res.ok) {
                    // Let the browser offer to save the password
                    history.pushState({}, "");
                }
            } finally {
                this.processing = false;
            }
        },

        /**
         * Go back to the email and password step, for a different account or a mistyped address
         * @returns {void}
         */
        restart() {
            this.tokenRequired = false;
            this.token = "";
            this.password = "";
            this.res = null;
        },

    },
};
</script>

<style lang="scss" scoped>
// Вид карточки описан в main.scss: вход и первый запуск выглядят одинаково,
// поэтому здесь не остается ничего своего
.spinner-border {
    margin-right: var(--gap-xs);
}
</style>
