import { createRouter, createWebHistory } from "vue-router";
import type { RouteLocationGeneric } from "vue-router";

import Layout from "./layouts/Layout.vue";
import Setup from "./pages/Setup.vue";
import Dashboard from "./pages/Dashboard.vue";
import DashboardHome from "./pages/DashboardHome.vue";
import Console from "./pages/Console.vue";
import Compose from "./pages/Compose.vue";
import StackInspector from "./pages/StackInspector.vue";
import ContainerTerminal from "./pages/ContainerTerminal.vue";

const NewStack = () => import("./pages/NewStack.vue");
const StackGitChanges = () => import("./pages/StackGitChanges.vue");

const Settings = () => import("./pages/Settings.vue");

// Settings - Sub Pages
import Appearance from "./components/settings/Appearance.vue";
import General from "./components/settings/General.vue";
const Security = () => import("./components/settings/Security.vue");
const Mcp = () => import("./components/settings/Mcp.vue");
const Users = () => import("./components/settings/Users.vue");
const Agents = () => import("./components/settings/Agents.vue");
const GlobalEnv = () => import("./components/settings/GlobalEnv.vue");
import About from "./components/settings/About.vue";

const routes = [
    {
        path: "/empty",
        component: Layout,
        children: [
            {
                path: "",
                component: Dashboard,
                children: [
                    {
                        name: "DashboardHome",
                        path: "/",
                        component: DashboardHome,
                        children: [
                            { path: "/stack/:stackName/git/:endpoint?",
                                component: StackGitChanges,
                                name: "stackGitChanges" },
                            // Файлы и журнал - вкладки той же страницы стека, а не
                            // отдельные экраны: компонент один, меняется только запись
                            // маршрута, поэтому переключение происходит на месте
                            {
                                path: "/stack/:stackName/files/:endpoint?",
                                component: StackInspector,
                                name: "stackFiles",
                            },
                            {
                                path: "/stack/:stackName/logs/:endpoint?",
                                component: StackInspector,
                                name: "stackLogs",
                            },
                            {
                                path: "/stack/:stackName/terminal/:endpoint?",
                                component: StackInspector,
                                name: "stackTerminal",
                            },
                            {
                                path: "/stack/:stackName",
                                component: StackInspector,
                                name: "stackInspector",
                            },
                            {
                                path: "/stack/:stackName/:endpoint",
                                component: StackInspector,
                                name: "stackInspectorEndpoint",
                            },
                            {
                                path: "/compose",
                                component: Compose,
                            },
                            // Старые адреса редактора ведут во вкладку файлов
                            {
                                path: "/compose/:stackName/:endpoint",
                                redirect: (to : RouteLocationGeneric) => `/stack/${to.params.stackName}/files/${to.params.endpoint}`,
                            },
                            {
                                path: "/compose/:stackName",
                                redirect: (to : RouteLocationGeneric) => `/stack/${to.params.stackName}/files`,
                            },
                            {
                                path: "/terminal/:stackName/:serviceName/:type",
                                component: ContainerTerminal,
                                name: "containerTerminal",
                            },
                            {
                                path: "/terminal/:stackName/:serviceName/:type/:endpoint",
                                component: ContainerTerminal,
                                name: "containerTerminalEndpoint",
                            },
                        ]
                    },
                    { path: "/new",
                        component: NewStack,
                        name: "newStack" },
                    {
                        path: "/console",
                        component: Console,
                    },
                    {
                        path: "/console/:endpoint",
                        component: Console,
                    },
                    {
                        path: "/settings",
                        component: Settings,
                        children: [
                            { path: "mcp",
                                component: Mcp },
                            {
                                path: "users",
                                component: Users },
                            { path: "agents",
                                component: Agents },
                            {
                                path: "general",
                                component: General,
                            },
                            {
                                path: "appearance",
                                component: Appearance,
                            },
                            {
                                path: "security",
                                component: Security,
                            },
                            {
                                path: "globalEnv",
                                component: GlobalEnv,
                            },
                            {
                                path: "about",
                                component: About,
                            },
                        ]
                    },
                ]
            },
        ]
    },
    {
        path: "/setup",
        component: Setup,
    },
];

export const router = createRouter({
    linkActiveClass: "active",
    history: createWebHistory(),
    routes,
});
