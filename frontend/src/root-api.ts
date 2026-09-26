import type { Socket } from "socket.io-client";
import type { Terminal } from "@xterm/xterm";
import type { SessionBootstrap, SessionBootstrapEvent } from "./session-bootstrap";
import type { ThemePreference } from "./theme-preference";
import type { AgentInfo, AgentInstance, HostContainers, SocketInfo, SocketResponse, StackList } from "./mixins/socket";
import type { PanelUpdateState } from "./panel-update-machine";
import type { AgentRequestOptions } from "./agent-requests";
import type {
    AgentRequestArgs,
    AgentRequestName,
    AgentRequestResult,
} from "../../common/agent-events";

/**
 * What every screen may use through `$root`.
 *
 * The session, the stacks and the way to reach an agent live in the mixins of the root
 * component, and a screen gets at them through `$root`. Vue types that as "some
 * component", so until this existed a misspelled field was `undefined` and a template
 * rendered it as nothing.
 *
 * It is written out rather than inferred from the root, because `$root` is part of the
 * type of every component, and a type that reads the root while describing it cannot be
 * computed. `RootApiCheck` in `root.ts` is what keeps the two from drifting apart: the
 * build fails when the root stops offering what is promised here.
 */
export interface DockgeRootApi {

    // The connection and who is on it

    socketIO : {
        firstConnect : boolean;
        connected : boolean;
        connectCount : number;
        initedSocketIO : boolean;
        connectionErrorMsg : string;
        showReverseProxyGuide : boolean;
        connecting : boolean;
    };
    info : SocketInfo;
    loggedIn : boolean;
    sessionBootstrap : SessionBootstrap;
    allowLoginDialog : boolean;
    /** True when this instance runs with authentication switched off */
    authDisabled : boolean;
    username : string | null;
    userID : string | null;
    userRole : "admin" | "operator" | "viewer";
    readonly appReady : boolean;
    readonly sessionBootstrapping : boolean;
    readonly sessionBootstrapError : string;
    readonly isAdmin : boolean;
    readonly canManageStacks : boolean;
    readonly usernameFirstChar : string;
    readonly frontendVersion : string;
    readonly isFrontendBackendVersionMatched : boolean;

    // Stacks and agents

    stackList : StackList;
    /** Stacks of every agent, by endpoint */
    allAgentStackList : Record<string, AgentInstance>;
    /** Containers outside every compose project, by endpoint, "" for this server */
    hostContainers : Record<string, HostContainers>;
    /** online / offline / connecting, by endpoint */
    agentStatusList : Record<string, string>;
    agentList : Record<string, AgentInfo>;
    readonly agentCount : number;
    /** Every stack of every endpoint, keyed by name and endpoint */
    readonly completeStackList : StackList;
    /** Stack that was just created, so the list can point at it */
    freshStack : string | null;
    /** When the stack list last arrived */
    stackListAt : number;
    /** Compose a new stack starts from, set by the screen that prepared it */
    composeTemplate : string;
    /** Environment a new stack starts from, set by the screen that prepared it */
    envTemplate : string;

    // Where the user is

    /** Agent the screens work with, null while nothing is selected */
    selectedEndpoint : string | null;
    createStackSeed : string;
    /** Opens the create sheet, while a layout that owns one is on screen */
    openCreateStack : (() => void) | null;
    isMobile : boolean;
    language : string;
    userTheme : ThemePreference;
    readonly theme : "light" | "dark";
    readonly isDark : boolean;

    // Talking to an agent

    getSocket() : Socket;

    /**
     * Send an event to an agent without waiting for it
     * @param endpoint Agent the event goes to
     * @param eventName Event of the agent protocol
     * @param args Arguments, with the acknowledgement last when the caller wants one
     */
    emitAgent<E extends AgentRequestName>(
        endpoint : string,
        eventName : E,
        ...args : [ ...AgentRequestArgs<E>, ack? : (response : AgentRequestResult<E>) => void ]
    ) : void;

    /**
     * Ask an agent something and always get an answer
     * @param endpoint Agent the request goes to
     * @param eventName Event of the agent protocol
     * @param args Arguments of that event, without the acknowledgement
     * @param options How long to wait
     * @returns The answer, or the unknown result
     */
    emitAgentRequest<E extends AgentRequestName>(
        endpoint : string,
        eventName : E,
        args : AgentRequestArgs<E>,
        options? : AgentRequestOptions<AgentRequestResult<E>>,
    ) : Promise<AgentRequestResult<E>>;

    /** End every request that is still waiting, because nothing will answer it */
    failPendingRequests() : void;

    bindTerminal(endpoint : string, terminalName : string, terminal : Terminal) : void;
    unbindTerminal(terminalName : string) : void;
    /** Display name of an agent, its address when it has no name */
    endpointDisplayFunction(endpoint : string) : string | undefined;

    // The session itself

    signIn(email : string, password : string) : Promise<SocketResponse>;
    verifyTwoFactor(code : string) : Promise<SocketResponse>;
    logout() : Promise<SocketResponse>;
    reconnectSocket(timeoutMs? : number) : Promise<boolean>;
    waitForSessionReady(timeoutMs? : number) : Promise<boolean>;
    applySessionBootstrap(event : SessionBootstrapEvent) : void;
    clearData() : void;
    /** Point the list at a stack that was just created, for a while */
    markStackFresh(name : string, durationMs? : number) : void;

    // Updating this panel

    /** The statechart of the update, run by the root because screens unmount while it runs */
    panelUpdate : PanelUpdateState;
    readonly panelUpdateView : "overlay" | "banner" | "none";
    /** While true the page neither reloads itself nor shows the lost connection banner */
    readonly panelUpdateSuppressing : boolean;
    panelUpdateInfo(latestVersion : string, updateAvailable : boolean) : void;
    panelUpdateCheck() : void;
    panelUpdateConfirm() : void;
    /** The password goes into the apply request and is kept nowhere */
    panelUpdateSubmit(password : string) : void;
    panelUpdateCancel() : void;
    /** Close a finished update for everyone; owners only */
    panelUpdateDismiss() : void;
    /** Close the dialog, the dry run or a result on this page only */
    panelUpdateClose() : void;

    // Saying something to the person

    /** Translate what the server sent, or say plainly that it was unexpected */
    translateServerMessage(key : string, values? : Record<string, unknown>) : string;
    /** Text of a reason the server sent, shown in place rather than in a toast */
    serverText(message : { key : string, values? : Record<string, unknown> } | string | undefined, fallback : string) : string;
    toastRes(res : { ok : boolean; msg? : string | { key : string; values? : Record<string, unknown> }; msgi18n? : boolean }) : void;
    toastSuccess(msg : string) : void;
    toastError(msg : string) : void;
}
