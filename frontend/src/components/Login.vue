<template>
    <div class="form-container">
        <div class="form">
            <form @submit.prevent="submit">
                <div v-if="!tokenRequired" class="form-floating">
                    <input id="floatingInput" v-model="email" type="email" class="form-control" placeholder="you@example.com" autocomplete="username" :disabled="processing" required>
                    <label for="floatingInput">{{ $t("Email") }}</label>
                </div>

                <div v-if="!tokenRequired" class="form-floating mt-3">
                    <input id="floatingPassword" v-model="password" type="password" class="form-control" placeholder="Password" autocomplete="current-password" :disabled="processing" required>
                    <label for="floatingPassword">{{ $t("Password") }}</label>
                </div>

                <!-- A backup code is longer than a TOTP code, so the field has to take both -->
                <div v-if="tokenRequired">
                    <div class="form-floating mt-3">
                        <input id="otp" ref="otp" v-model="token" type="text" maxlength="16" class="form-control" placeholder="123456" autocomplete="one-time-code" :disabled="processing" required>
                        <label for="otp">{{ $t("Token") }}</label>
                    </div>
                    <p class="form-text">{{ $t("twoFactorCodeHint") }}</p>
                </div>

                <button class="w-100 btn btn-primary mt-3" type="submit" :disabled="processing">
                    <div v-if="processing" class="spinner-border spinner-border-sm me-1"></div>
                    {{ $t("Login") }}
                </button>

                <button v-if="tokenRequired" class="w-100 btn btn-link mt-2" type="button" :disabled="processing" @click="restart">
                    {{ $t("backToLogin") }}
                </button>

                <div v-if="res && !res.ok" class="alert alert-danger mt-3" role="alert">
                    {{ $t(res.msg) }}
                </div>
            </form>
        </div>
    </div>
</template>

<script>
export default {
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
.form-container {
    display: flex;
    align-items: center;
    padding-top: 40px;
    padding-bottom: 40px;
}

.form-floating {
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
</style>
