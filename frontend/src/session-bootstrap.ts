export interface SessionBootstrap {
    generation : number;
    userID : string | null;
    confirmedUserID : string | null;
    profileReady : boolean;
    agentsReady : boolean;
    stacksReady : boolean;
    ready : boolean;
    anonymous : boolean;
    error : string;
}

export type SessionBootstrapEvent =
    | { type : "connected" | "anonymous" }
    | { type : "identity"; userID : string }
    | { type : "profile"; generation : number; userID : string }
    | { type : "agents" | "stacks"; generation : number }
    | { type : "failed"; generation : number; message : string };

/** Start with unknown authentication, distinct from an authenticated empty inventory. */
export function createSessionBootstrap() : SessionBootstrap {
    return { generation: 0,
        userID: null,
        confirmedUserID: null,
        profileReady: false,
        agentsReady: false,
        stacksReady: false,
        ready: false,
        anonymous: false,
        error: "" };
}

/** Whether the current connection has supplied a complete initial workspace snapshot. */
export function sessionConnectionReady(state : SessionBootstrap) : boolean {
    return Boolean(state.confirmedUserID && state.profileReady && state.agentsReady && state.stacksReady);
}

/** Advance only with evidence from the current connection; retain a ready same-user view. */
export function reduceSessionBootstrap(state : SessionBootstrap, event : SessionBootstrapEvent) : SessionBootstrap {
    if (event.type === "connected") {
        return { ...createSessionBootstrap(),
            generation: state.generation + 1,
            userID: state.userID,
            ready: state.ready };
    }
    if (event.type === "anonymous") {
        return { ...createSessionBootstrap(),
            generation: state.generation + 1,
            anonymous: true };
    }
    if ("generation" in event && event.generation !== state.generation) {
        return state;
    }
    const next = { ...state };
    if (event.type === "identity") {
        if (state.userID && state.userID !== event.userID) {
            next.ready = false;
            next.profileReady = false;
            next.agentsReady = false;
            next.stacksReady = false;
        }
        next.userID = event.userID;
        next.confirmedUserID = event.userID;
        next.anonymous = false;
    } else if (event.type === "profile") {
        if (event.userID !== state.confirmedUserID) {
            return state;
        }
        next.profileReady = true;
    } else if (event.type === "agents") {
        next.agentsReady = true;
    } else if (event.type === "stacks") {
        next.stacksReady = true;
    } else if (event.type === "failed") {
        next.error = event.message;
    }
    if (sessionConnectionReady(next)) {
        next.ready = true;
        next.error = "";
    }
    return next;
}
