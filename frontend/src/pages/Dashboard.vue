<template>
    <div class="dashboard">
        <button ref="stackToggle" class="mobile-stack-toggle" type="button" :aria-expanded="String(listOpen)" aria-controls="stack-navigation" @click="listOpen = !listOpen">
            <font-awesome-icon icon="list" />{{ $t("stacksTab") }}<span>{{ stackCount }}</span><font-awesome-icon :icon="listOpen ? 'times' : 'chevron-down'" />
        </button>
        <aside v-show="!$root.isMobile || listOpen" id="stack-navigation" class="list-column" :aria-label="$t('stacksTab')">
            <router-link to="/" class="overview-link" :class="{ selected: $route.path === '/' }">
                <InterfaceIcon name="overview" />{{ $t("familiarOverview") }}
            </router-link>
            <div class="sidebar-heading">
                <span>{{ $t("stacksTab") }} <small>{{ stackCount }}</small></span>
                <button v-if="$root.canManageStacks" class="add-stack" type="button" :aria-label="$t('familiarNewStack')" @click="$root.openCreateStack?.()">
                    <font-awesome-icon icon="plus" />
                </button>
            </div>
            <StackList :scrollbar="true" />
            <div v-if="$root.canManageStacks" class="sidebar-footer">
                <button class="btn btn-normal" type="button" @click="$root.openCreateStack?.()"><font-awesome-icon icon="plus" /> {{ $t("familiarNewStack") }}</button>
                <span><ShieldCheck />{{ $t("familiarOwnFiles") }}</span>
            </div>
        </aside>
        <div ref="workspace" class="work-column" tabindex="-1">
            <router-view />
        </div>
    </div>
</template>

<script>
import InterfaceIcon from "../components/InterfaceIcon.vue";
import ShieldCheck from "../components/ShieldCheck.vue";
import StackList from "../components/StackList.vue";
export default {
    components: { InterfaceIcon,
        StackList,
        ShieldCheck },
    data() {
        return { listOpen: false };
    },
    computed: {
        stackCount() {
            return Object.values(this.$root.completeStackList).filter(stack => this.$root.selectedEndpoint === null || (stack.endpoint || "") === this.$root.selectedEndpoint).length;
        },
    },
    watch: {
        "$route.path"() {
            const fromNavigation = this.listOpen && this.$root.isMobile;
            this.listOpen = false;
            if (fromNavigation) {
                this.$nextTick(() => this.$refs.workspace?.focus({ preventScroll: true }));
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.mobile-stack-toggle { display: none; }
.dashboard { display: grid; grid-template-columns: var(--sidebar-width) minmax(0, 1fr); min-height: calc(100vh - var(--header-height)); }
.list-column { min-width: 0; background: var(--surface-sidebar); border-right: 1px solid var(--line-hair); padding: var(--gap-md) var(--gap-md) var(--gap-lg); display: flex; flex-direction: column; gap: var(--gap-md); }
.work-column:focus { outline: none; }
// Колонка - flex по вертикали: страница стека растягивается до ее низа, остальные страницы берут высоту содержимого
.work-column { display: flex; flex-direction: column; min-width: 0; padding: var(--gap-2xl) var(--gap-2xl) var(--gap-3xl); }
.overview-link { display: flex; align-items: center; gap: var(--gap-sm); padding: var(--gap-sm); border-radius: var(--radius-control); color: var(--text-muted); text-decoration: none; font-weight: var(--weight-medium); }
.overview-link.selected { background: var(--surface-raised); color: var(--text-strong); }
.sidebar-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 var(--gap-sm); font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--text-muted); }
.sidebar-heading small { margin-left: var(--gap-xs); color: var(--text-faint); }
.add-stack { background: transparent; border: none; color: var(--text-muted); min-width: var(--control-height); min-height: var(--control-height); }
.sidebar-footer { margin-top: auto; padding: var(--gap-lg) var(--gap-sm) 0; display: flex; flex-direction: column; gap: var(--gap-md); }
.sidebar-footer .btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--gap-sm); min-height: var(--field-height); }
.sidebar-footer span { display: flex; align-items: center; justify-content: center; gap: var(--gap-sm); color: var(--text-faint); font-size: var(--text-xs); text-align: center; }
@media (min-width: 801px) {
    .list-column { position: sticky; top: 0; height: calc(100dvh - var(--header-height)); overflow: hidden; }
    .list-column :deep(.stack-list) { min-height: 0; max-height: none; flex: 1; }
    .list-column :deep(.list-box) { min-height: 0; flex: 1; display: flex; flex-direction: column; }
}
@media (min-width: 1700px) { .work-column { padding-left: var(--gap-3xl); padding-right: var(--gap-3xl); } }
@media (max-width: 1100px) { .work-column { padding: var(--gap-xl); } }
@media (max-width: 800px) {
    .dashboard { display: block; }
    .mobile-stack-toggle { display: flex; align-items: center; gap: var(--gap-sm); min-height: var(--control-height-touch); width: 100%; border: 0; border-bottom: 1px solid var(--line-hair); background: var(--surface-sidebar); color: var(--text-strong); padding: 0 var(--gap-md); font-size: var(--text-sm); }
    .mobile-stack-toggle span { color: var(--text-muted); margin-right: auto; }
    // Ящик со стеками сам не прокручивается: прокрутка живет внутри списка,
    // и она одна. Пока прокручивались обе коробки, палец на телефоне попадал
    // то в список, то в ящик, то в страницу - три вложенных полосы подряд
    .list-column { border: 0; border-bottom: 1px solid var(--line-hair); padding: var(--gap-md); gap: var(--gap-sm); }
    // Имя раздела уже стоит на кнопке, которая открыла ящик: второй раз его
    // писать незачем, а вот создание стека получает подписанную кнопку внизу
    .sidebar-heading { display: none; }
    .sidebar-footer { padding: var(--gap-md) 0 0; }
    .sidebar-footer span { display: none; }
    .overview-link { padding: var(--gap-sm); min-height: var(--control-height-touch); }
    .work-column { padding: var(--gap-xl) var(--gap-md); }
}
</style>
