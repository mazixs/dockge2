<template>
    <svg class="interface-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <template v-if="name === 'box'"><path d="m12 3 9 5v8l-9 5-9-5V8Z" /><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5" /></template>
        <template v-else-if="name === 'file'"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M9 13l-2 2 2 2M15 13l2 2-2 2" /></template>
        <template v-else-if="name === 'logs'"><path d="M4 6h16M4 10h10M4 14h16M4 18h7" /></template>
        <template v-else-if="name === 'terminal'"><path d="m4 6 6 6-6 6M13 18h7" /></template>
        <template v-else-if="name === 'git'"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 8v2a5 5 0 0 1-5 5H6" /></template>
        <template v-else-if="name === 'server'"><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01" /></template>
        <template v-else-if="name === 'refresh'"><path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2" /></template>
        <template v-else-if="name === 'stop'"><rect x="5" y="5" width="14" height="14" rx="2" /></template>
        <template v-else-if="name === 'overview'"><path d="M3 3v18h18M6 14l4-5 4 3 6-7" /></template>
        <template v-else-if="name === 'network'"><circle cx="12" cy="4.5" r="2.2" /><circle cx="5" cy="18" r="2.2" /><circle cx="19" cy="18" r="2.2" /><path d="M12 6.7v4.8M12 11.5 6.7 16.2M12 11.5l5.3 4.7" /></template>
        <template v-else-if="name === 'volume'"><ellipse cx="12" cy="6" rx="7" ry="2.8" /><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6" /><path d="M19 12c0 1.5-3.1 2.8-7 2.8S5 13.5 5 12" /></template>
        <template v-else-if="name === 'image'"><path d="m12 3 8.5 4.2L12 11.4 3.5 7.2Z" /><path d="m3.5 12 8.5 4.2 8.5-4.2M3.5 16.8 12 21l8.5-4.2" /></template>
        <template v-else-if="name === 'check'"><path d="m5 12.5 4.5 4.5L19 7" /></template>
        <template v-else-if="name === 'cross'"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></template>
        <template v-else-if="name === 'lock'"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7.5a4 4 0 0 1 8 0V11M12 15v2" /></template>
        <template v-else-if="name === 'sliders'"><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></template>
        <template v-else-if="name === 'users'"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0M15.8 5.2a3.2 3.2 0 0 1 0 5.6M17.4 13.5a5.5 5.5 0 0 1 3.1 6" /></template>
        <template v-else-if="name === 'question'"><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.6M12 17h.01" /></template>
        <template v-else-if="name === 'key'"><circle cx="7.5" cy="12" r="3.5" /><path d="M11 12h9.5M17 12v3.2M20.5 12v2.4" /></template>
    </svg>
</template>
<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
    props: { name: { type: String,
        required: true } },
});
</script>
<style scoped>
.interface-icon { width: 1em; height: 1em; flex-shrink: 0; vertical-align: -.125em; }
</style>
