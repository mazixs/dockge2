<template>
    <!-- The owner who follows an update sees it over the whole page: the panel restarts
         under it, and nothing behind it answers until the update ends -->
    <div v-if="mode === 'overlay'" class="panel-update-layer">
        <!-- A click beside the card must not drop focus to the inert page behind it -->
        <div class="scrim" aria-hidden="true" @mousedown.prevent></div>
        <section
            ref="dialog"
            class="panel-update"
            :class="tone"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
            @keydown.tab="keepFocusInside"
            @keydown.esc.stop="onEscape"
        >
            <h2 :id="titleId" class="panel-update-title">{{ title }}</h2>
            <p v-if="observer" class="panel-update-note">{{ $t("panelUpdateObserver") }}</p>

            <ol v-if="steps.length" class="panel-update-steps">
                <li v-for="step in steps" :key="step.key" :class="step.mark" :aria-current="step.mark === 'current' ? 'step' : undefined">
                    <span class="step-mark" aria-hidden="true"><InterfaceIcon v-if="step.mark === 'done'" name="check" /></span>
                    <span class="step-label">{{ $t(`panelUpdateStep.${step.key}`) }}</span>
                    <span class="visually-hidden">{{ markText(step.mark) }}</span>
                </li>
            </ol>
            <p v-if="stoppedAt" class="panel-update-note">{{ $t("panelUpdateStoppedAt", { step: stoppedAt }) }}</p>

            <p class="panel-update-line" role="status" aria-live="polite" aria-atomic="true">{{ lineText }}</p>
            <p v-if="running" class="panel-update-note">{{ $t("panelUpdateElapsed", { time: elapsed }) }}</p>
            <p v-if="noticeKey" class="panel-update-warning">{{ $t(noticeKey) }}</p>
            <p v-if="stacksRun" class="panel-update-note">{{ $t("panelUpdateStacksRun") }}</p>
            <p v-if="offline" class="panel-update-warning">{{ $t("panelUpdateNoReload") }}</p>

            <template v-if="outcome">
                <p v-if="reasonKey" class="panel-update-note">{{ $t(reasonKey) }}</p>
                <p v-if="dataKey" class="panel-update-note">{{ $t(dataKey) }}</p>
                <p v-if="errorDetail" class="panel-update-note">{{ $t("panelUpdateErrorDetail") }}: <code>{{ errorDetail }}</code></p>
            </template>

            <div v-if="hostLines.length" class="panel-update-host">
                <h3 class="panel-update-subtitle">{{ $t("panelUpdateHostCommands") }}</h3>
                <template v-for="line in hostLines" :key="line.command">
                    <p v-if="line.label" class="panel-update-note">{{ $t(line.label) }}</p>
                    <pre class="host-command"><code>{{ line.command }}</code></pre>
                </template>
                <p v-if="!installDir" class="panel-update-note">{{ $t("panelUpdateHostDir", { dir: placeholder }) }}</p>
            </div>

            <div v-if="canCancel || stalled || closable" class="panel-update-actions">
                <button v-if="canCancel" class="btn btn-normal" type="button" @click="$root.panelUpdateCancel()">{{ $t("panelUpdateCancel") }}</button>
                <button v-if="stalled" class="btn btn-primary" type="button" @click="reload">{{ $t("panelUpdateReload") }}</button>
                <button v-if="closable" class="btn btn-primary" type="button" @click="close">{{ $t("close") }}</button>
            </div>
        </section>
    </div>

    <!-- Everyone else, and an owner signing in again, keeps the page and reads one line -->
    <div v-else class="panel-update-banner" :class="tone">
        <p class="banner-text" role="status" aria-live="polite" aria-atomic="true">
            <strong>{{ bannerTitle }}</strong>
            <span>{{ lineText }}</span>
        </p>
        <button v-if="stalled" class="btn btn-sm btn-primary" type="button" @click="reload">{{ $t("panelUpdateReload") }}</button>
        <button v-if="closable" class="btn btn-sm btn-normal" type="button" @click="close">{{ $t("close") }}</button>
    </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import {
    PANEL_UPDATE_DIR_PLACEHOLDER,
    panelUpdateCanCancel,
    panelUpdateHostCase,
    panelUpdateHostLines,
    panelUpdateLine,
    panelUpdateSteps,
    type PanelUpdateNode,
    type PanelUpdateOutcomeKind,
    type PanelUpdateProgress,
    type PanelUpdateState,
    type PanelUpdateStepMark,
} from "../panel-update-machine";

/** Progress states in which the panel is down or restarting while the stacks keep running */
const CUTOVER : PanelUpdateProgress[] = [ "stopping", "snapshot", "target-starting", "verifying", "rolling-back", "step-unknown" ];

/** Colour that supports the words of each result; the words say it first */
const TONES : Record<PanelUpdateOutcomeKind, string> = {
    "updated": "tone-running",
    "not-changed": "tone-stopped",
    "rolled-back": "tone-attention",
    "recovery-required": "tone-failed",
    "unknown": "tone-unknown",
};

let instances = 0;

export default defineComponent({
    components: { InterfaceIcon },
    props: {
        /** "overlay" for the owner who follows the update, "banner" for everyone else */
        mode: { type: String,
            required: true },
    },
    data() {
        instances += 1;
        return {
            now: Date.now(),
            titleId: `panel-update-title-${instances}`,
            clock: undefined as ReturnType<typeof setInterval> | undefined,
            returnFocus: null as HTMLElement | null,
        };
    },
    computed: {
        state() : PanelUpdateState {
            return this.$root.panelUpdate;
        },
        node() : PanelUpdateNode {
            return this.state.node;
        },
        running() : boolean {
            return this.node.name === "running";
        },
        outcome() : boolean {
            return this.node.name === "outcome";
        },
        observer() : boolean {
            return this.node.name === "running" && this.node.observer;
        },
        tone() : string {
            return this.node.name === "outcome" ? TONES[this.node.sub] : "tone-accent";
        },
        title() : string {
            const node = this.node;
            if (node.name === "outcome") {
                return this.$t(`panelUpdateOutcome.${node.sub}`, { from: node.from,
                    to: node.to });
            }
            return node.name === "running" ? this.$t("panelUpdateTitle", { from: node.from,
                to: node.to }) : "";
        },
        bannerTitle() : string {
            return this.node.name === "running" ? this.$t("panelUpdateInProgress", { version: this.node.to }) : this.title;
        },
        steps() : PanelUpdateStepMark[] {
            const node = this.node;
            if (node.name === "running") {
                return panelUpdateSteps(node.phase);
            }
            if (node.name === "outcome" && (node.sub === "updated" || node.sub === "rolled-back")) {
                return panelUpdateSteps(node.sub === "updated" ? "success" : "recovered", true);
            }
            return [];
        },
        /** Where an update that did not finish stopped, when that is a known step */
        stoppedAt() : string {
            const node = this.node;
            if (node.name !== "outcome" || this.steps.length > 0) {
                return "";
            }
            const current = panelUpdateSteps(node.phase).find((step) => step.mark === "current");
            return current ? this.$t(`panelUpdateStep.${current.key}`) : "";
        },
        lineText() : string {
            const line = panelUpdateLine(this.state);
            return line ? this.$t(line.key, line.values) : "";
        },
        elapsed() : string {
            const node = this.node;
            const seconds = node.name === "running" ? Math.max(0, Math.floor((this.now - node.startedAt) / 1000)) : 0;
            const clock = [ Math.floor(seconds / 60) % 60, seconds % 60 ].map((part) => String(part).padStart(2, "0")).join(":");
            return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${clock}` : clock;
        },
        noticeKey() : string {
            const node = this.node;
            if (node.name !== "running" || !node.notice) {
                return "";
            }
            return node.notice === "too-late" ? "panelUpdateTooLate" : "panelUpdateCancelFailed";
        },
        offline() : boolean {
            return this.running && this.state.ctx.link.kind === "offline";
        },
        stacksRun() : boolean {
            return this.node.name === "running" && CUTOVER.includes(this.node.progress);
        },
        reasonKey() : string {
            const code = this.node.name === "outcome" ? this.node.result.code : null;
            return code && this.$te(`panelUpdateReason.${code}`) ? `panelUpdateReason.${code}` : "";
        },
        dataKey() : string {
            const node = this.node;
            if (node.name !== "outcome") {
                return "";
            }
            if (node.sub === "rolled-back") {
                // Without the updater's word on the data, the page claims nothing about it
                if (node.result.restoredData === null) {
                    return "";
                }
                return node.result.restoredData ? "panelUpdateRestoredData" : "panelUpdateDataKept";
            }
            return node.sub === "not-changed" ? "panelUpdateDataKept" : "";
        },
        errorDetail() : string | null {
            return this.node.name === "outcome" ? this.node.result.error : null;
        },
        installDir() : string | undefined {
            return this.state.ctx.status?.panel.installDir;
        },
        placeholder() : string {
            return PANEL_UPDATE_DIR_PLACEHOLDER;
        },
        hostLines() : { label : string | null; command : string }[] {
            const kind = panelUpdateHostCase(this.state);
            return kind ? panelUpdateHostLines(kind, this.installDir) : [];
        },
        canCancel() : boolean {
            return this.$root.isAdmin && panelUpdateCanCancel(this.state);
        },
        stalled() : boolean {
            return this.node.name === "outcome" && this.node.stalled;
        },
        /** Every result can be closed, except while the page is about to reload itself */
        closable() : boolean {
            return this.node.name === "outcome" && this.node.updated !== "reloading";
        },
    },
    watch: {
        running: {
            immediate: true,
            handler(running : boolean) {
                clearInterval(this.clock);
                this.clock = running ? setInterval(() => {
                    this.now = Date.now();
                }, 1000) : undefined;
                this.now = Date.now();
            },
        },
        mode(mode : string) {
            // After the render: until then the page behind is still inert and refuses focus
            this.$nextTick(mode === "overlay" ? this.takeFocus : this.giveFocusBack);
        },
    },
    mounted() {
        this.takeFocus();
    },
    beforeUnmount() {
        clearInterval(this.clock);
    },
    unmounted() {
        // Layout lifts inert in the same render that removes this component, before this hook
        this.giveFocusBack();
    },
    methods: {
        /** Move focus into the dialog, remembering where it was so it can go back */
        takeFocus() {
            const dialog = this.$refs.dialog as HTMLElement | undefined;
            if (this.mode !== "overlay" || !dialog) {
                return;
            }
            if (!dialog.contains(document.activeElement) && document.activeElement instanceof HTMLElement) {
                this.returnFocus = document.activeElement;
            }
            dialog.focus();
        },

        /** Return focus to where it was before the dialog took it, if that is still on the page */
        giveFocusBack() {
            const target = this.returnFocus;
            this.returnFocus = null;
            if (target?.isConnected) {
                target.focus();
            }
        },

        /**
         * Keep Tab inside the dialog: the page behind it is inert
         * @param event The Tab press
         */
        keepFocusInside(event : KeyboardEvent) {
            const dialog = this.$refs.dialog as HTMLElement | undefined;
            if (!dialog) {
                return;
            }
            const reachable = [ ...dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])") ];
            const first = reachable[0];
            const last = reachable[reachable.length - 1];
            if (!first || !last) {
                event.preventDefault();
                return;
            }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
                last.focus();
                event.preventDefault();
            } else if (!event.shiftKey && document.activeElement === last) {
                first.focus();
                event.preventDefault();
            }
        },

        /** Escape closes a result; a running update has nothing to close */
        onEscape() {
            if (this.closable) {
                this.close();
            }
        },

        /**
         * The owner's Close removes the finished helper for everyone; anyone else closes it here
         */
        close() {
            if (this.$root.isAdmin) {
                this.$root.panelUpdateDismiss();
            } else {
                this.$root.panelUpdateClose();
            }
        },

        reload() {
            window.location.reload();
        },

        /**
         * @param mark Mark of a step
         * @returns The mark in words, for a screen reader
         */
        markText(mark : string) {
            if (mark === "done") {
                return this.$t("panelUpdateStepDone");
            }
            return mark === "current" ? this.$t("panelUpdateStepCurrent") : this.$t("panelUpdateStepPending");
        },
    },
});
</script>

<style lang="scss" scoped>
.panel-update-layer {
    position: fixed;
    inset: 0;
    z-index: var(--layer-modal);
    display: grid;
    place-items: center;
    padding: var(--gap-lg);
    overflow-y: auto;
}

.scrim {
    position: fixed;
    inset: 0;
    background-color: var(--scrim);
}

.panel-update {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
    width: min(560px, 100%);
    padding: var(--gap-xl);
    border: 1px solid var(--line-hair);
    border-top: 3px solid var(--tone);
    border-radius: var(--radius-panel);
    background-color: var(--surface-panel);
    box-shadow: var(--shadow-panel);
    color: var(--text-base);

    // The card takes focus only so that Tab starts inside it; like a Bootstrap modal it is
    // not a control and draws no ring
    &:focus {
        outline: none;
    }

    p {
        margin: 0;
    }
}

.tone-accent { --tone: var(--accent-text); }
.tone-running { --tone: var(--state-running); }
.tone-stopped { --tone: var(--state-stopped); }
.tone-attention { --tone: var(--state-attention); }
.tone-failed { --tone: var(--state-failed); }
.tone-unknown { --tone: var(--state-unknown); }

.panel-update-title {
    margin: 0;
    font-size: var(--text-lg);
    line-height: var(--line-lg);
    font-weight: var(--weight-strong);
    color: var(--text-strong);
}

.panel-update-subtitle {
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    font-weight: var(--weight-strong);
    color: var(--text-strong);
}

.panel-update-steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--gap-sm) var(--gap-lg);
    margin: 0;
    padding: 0;
    list-style: none;

    li {
        display: flex;
        align-items: center;
        gap: var(--gap-xs);
        font-size: var(--text-sm);
        line-height: var(--line-sm);
        color: var(--text-faint);
    }

    .done {
        color: var(--text-muted);
    }

    .current {
        color: var(--text-strong);
        font-weight: var(--weight-strong);
    }
}

.step-mark {
    display: grid;
    place-items: center;
    width: var(--icon-md);
    height: var(--icon-md);
    border: 1px solid currentColor;
    border-radius: 50%;
    font-size: var(--text-xs);

    .done & {
        border-color: var(--state-running);
        color: var(--state-running);
    }

    .current & {
        border-color: var(--accent-text);
        background-color: var(--accent-soft);
    }
}

@media (prefers-reduced-motion: no-preference) {
    .current .step-mark {
        animation: step-pulse var(--motion-slow) var(--motion-ease) infinite alternate;
    }
}

@keyframes step-pulse {
    to {
        background-color: transparent;
    }
}

.panel-update-line {
    color: var(--text-strong);
}

.panel-update-note {
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-muted);

    code {
        color: var(--text-strong);
        overflow-wrap: anywhere;
    }
}

.panel-update-warning {
    padding: var(--gap-sm) var(--gap-md);
    border-left: 3px solid var(--state-attention);
    background-color: color-mix(in srgb, var(--state-attention) 8%, transparent);
    font-size: var(--text-sm);
    line-height: var(--line-sm);
    color: var(--text-strong);
}

.panel-update-host {
    display: flex;
    flex-direction: column;
    gap: var(--gap-sm);
}

.host-command {
    margin: 0;
    padding: var(--gap-sm) var(--gap-md);
    border-radius: var(--radius-control);
    background-color: var(--surface-sunken);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--line-code);
    color: var(--text-strong);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: all;
}

.panel-update-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--gap-sm);
}

.panel-update-banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-sm) var(--gap-md);
    padding: var(--gap-sm) var(--gap-xl);
    border-bottom: 1px solid var(--line-hair);
    border-left: 3px solid var(--tone);
    background-color: var(--surface-panel);
    color: var(--text-base);
}

.banner-text {
    display: flex;
    flex: 1 1 280px;
    flex-wrap: wrap;
    gap: var(--gap-xs) var(--gap-sm);
    margin: 0;
    font-size: var(--text-sm);
    line-height: var(--line-sm);

    strong {
        color: var(--text-strong);
        font-weight: var(--weight-strong);
    }
}

@media (max-width: 800px) {
    .panel-update-layer {
        padding: var(--gap-md);
        place-items: start center;
    }

    .panel-update {
        padding: var(--gap-lg);
    }

    .panel-update-banner {
        padding: var(--gap-sm) var(--gap-md);
    }
}
</style>
