import { createRouter, createWebHistory } from "vue-router";
import type { RouteLocationGeneric } from "vue-router";

import Layout from "./layouts/Layout.vue";
import Setup from "./pages/Setup.vue";
import Dashboard from "./pages/Dashboard.vue";
import DashboardHome from "./pages/DashboardHome.vue";

// Loaded when the screen is opened, not when the panel starts. The dashboard is what
// the browser has to draw first; the inspector brings the compose editor, and both
// terminal screens bring xterm, which together are the larger half of the interface
const Console = () => import("./pages/Console.vue");
const Compose = () => import("./pages/Compose.vue");
const StackInspector = () => import("./pages/StackInspector.vue");
const ContainerTerminal = () => import("./pages/ContainerTerminal.vue");

const NewStack = () => import("./pages/NewStack.vue");
const StackGitChanges = () => import("./pages/StackGitChanges.vue");

const Settings = () => import("./pages/Settings.vue");

// Settings - Sub Pages
const Appearance = () => import("./components/settings/Appearance.vue");
const General = () => import("./components/settings/General.vue");
const Security = () => import("./components/settings/Security.vue");
const Mcp = () => import("./components/settings/Mcp.vue");
const Users = () => import("./components/settings/Users.vue");
const Agents = () => import("./components/settings/Agents.vue");
const GlobalEnv = () => import("./components/settings/GlobalEnv.vue");
const About = () => import("./components/settings/About.vue");

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
