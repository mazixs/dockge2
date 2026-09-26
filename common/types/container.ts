import type { PanelMount } from "./panel-container";

/**
 * Where a container comes from, told by the labels Compose writes and never by its name.
 *
 * `managed` - a compose project whose directory lies in the stacks directory;
 * `external-compose` - a compose project started from anywhere else;
 * `standalone` - no compose labels at all, `docker run` or another tool;
 * `unknown` - labels that are partial or could not be read.
 */
export type ContainerSource = "managed" | "external-compose" | "standalone" | "unknown";

/** A container outside every compose project, as the stack list shows it */
export interface StandaloneContainer {
    /** Full id: a name can be reused by the next container, the id cannot */
    id : string;
    name : string;
    image : string;
    /** Docker state in lower case, "unknown" when Docker could not be read since it was seen */
    state : string;
    /** Docker's own words about it, for example "Up 3 hours", empty when unknown */
    status : string;
    /** healthy, unhealthy or starting; empty without a healthcheck */
    health : string;
    /** Exit code of the last run, null when it is running or Docker did not say */
    exitCode : number | null;
    source : "standalone" | "unknown";
    /** When a Docker reading last included it, in milliseconds */
    lastSeen : number;
}

/** A port a container publishes, as Docker reports it */
export interface ContainerPort {
    /** Port inside the container with its protocol, for example "80/tcp" */
    container : string;
    /** Address and port on the host, empty when the port is exposed but not published */
    host : string;
}

/**
 * What the page of one container shows, read from Docker when the page opens.
 *
 * Environment, command and labels are deliberately absent: they hold credentials often
 * enough, and nothing on the page needs them.
 */
export interface ContainerDetails {
    id : string;
    name : string;
    image : string;
    source : ContainerSource;
    /** Compose project and service, empty for a standalone container */
    project : string;
    service : string;
    workingDir : string;
    state : string;
    health : string;
    startedAt : string;
    finishedAt : string;
    restartCount : number | null;
    exitCode : number | null;
    ports : ContainerPort[];
    mounts : PanelMount[];
    networks : string[];
    /** True for the panel's own container, which is never controlled from here */
    panel : boolean;
}

/** What the container page may do; removing, killing and exec wait for their own access model */
export const CONTAINER_ACTIONS = [ "start", "stop", "restart" ] as const;
export type ContainerAction = typeof CONTAINER_ACTIONS[number];

/** Owner setting that lets operators start, stop and restart containers the panel does not manage */
export const CONTAINER_CONTROL_SETTING = "containerControl";

/** Local event an owner turns that setting on and off with */
export const SET_CONTAINER_CONTROL_EVENT = "setContainerControl";
