/** One mount of the panel's container */
export interface PanelMount {
    type : string;
    source : string;
    destination : string;
    readOnly : boolean;
}

/**
 * The panel's own container, as the card in "About" shows it.
 *
 * An empty text or null means Docker did not say, and the card shows it as unknown.
 */
export interface PanelContainer {
    id : string;
    name : string;
    /** Compose project around the panel, empty when it was started without Compose */
    project : string;
    service : string;
    /** Directory Compose recorded for the project */
    workingDir : string;
    configFiles : string;
    image : string;
    /** Registry digest of the image, empty for a local build */
    digest : string;
    state : string;
    /** healthy, unhealthy or starting; empty when the image has no healthcheck */
    health : string;
    startedAt : string;
    restartCount : number | null;
    mounts : PanelMount[];
    /** Whether the Docker socket is mounted, which gives the panel the host */
    dockerSocket : boolean;
}

/** Owner-only event that describes the panel's container */
export const PANEL_CONTAINER_EVENT = "panelContainer";

/** Answer to it: null when the panel does not run in a container Docker knows */
export type PanelContainerAck = { ok : true; container : PanelContainer | null } | { ok : false; msg : string; msgi18n : true };
