<template>
    <div v-if="$route.path === '/setup'" class="setup-theme"><ThemePicker compact /></div>
    <router-view />
</template>
<script>
import ThemePicker from "./components/ThemePicker.vue";
export default { components: { ThemePicker } };
</script>
<style lang="scss" scoped>
.setup-theme { display: flex; justify-content: flex-end; padding: 20px 24px; }
</style>
