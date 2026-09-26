import type { PanelUpdateOperation, PanelUpdateOutcome, PanelUpdateStatus } from "../../common/panel-update";
import { MemoryStorage, installGlobal } from "./vue-instance";

// Invented versions and request ids, in the formats the panel accepts
export const FROM = "0.0.13";
export const TO = "0.0.14";
export const APPLY_ID = "0a1b2c3d-0000-4000-8000-000000000002";

/** The page the socket mixin runs in, as far as it reaches into it */
export interface SocketPage extends EventTarget {
    location : {
        protocol : string;
        hostname : string;
        host : string;
        /** How often the page was reloaded */
        reloads : number;
        reload : () => void;
    };
    sessionStorage : MemoryStorage;
}

/**
 * Install what `frontend/src/mixins/socket.ts` reads while it is imported: the location
 * the auth client is built from, the storages and the build version.
 *
 * `window` is left to the test, to install after the import: the auth client checks for a
 * window while it is created, and without one it stays the plain HTTP client the mixin uses.
 * @param host Host and port of the server the page was loaded from
 * @param version Version of this build of the page
 * @returns The page, with a reload counter and its tab storage
 */
export function installSocketPage(host : string, version : string) : SocketPage {
    const tabStorage = new MemoryStorage();
    const location = { protocol: "http:",
        hostname: host.split(":")[0] ?? host,
        host,
        reloads: 0,
        reload() {
            location.reloads++;
        } };
    const page = Object.assign(new EventTarget(), { location,
        sessionStorage: tabStorage });

    installGlobal("location", () => location);
    // `localStorage.dev` switches to the development backend and is read without a guard
    installGlobal("localStorage", () => ({}));
    installGlobal("sessionStorage", () => tabStorage);
    Object.assign(globalThis, { FRONTEND_VERSION: version });
    return page;
}

/**
 * A status as the panel sends it
 * @param version Version the answering panel runs
 * @param operation Operation of the updater, if one is known
 * @param managed Whether the panel can update itself
 * @returns The status
 */
export function panelStatus(version : string, operation? : PanelUpdateOperation, managed : "yes" | "no" = "yes") : PanelUpdateStatus {
    const status : PanelUpdateStatus = { schema: 1,
        panel: { version,
            managed } };
    if (managed === "no") {
        status.panel.reason = "not-container";
    }
    if (operation) {
        status.operation = operation;
    }
    return status;
}

/**
 * An operation of the updater, started now
 * @param kind Dry run or update
 * @param requestId Request the page sent
 * @param outcome How it ended; running while absent
 * @param to Version it goes to
 * @returns The operation
 */
export function panelOperation(kind : "preview" | "apply", requestId : string, outcome? : PanelUpdateOutcome, to = TO) : PanelUpdateOperation {
    const now = new Date().toISOString();
    const operation : PanelUpdateOperation = { requestId,
        kind,
        from: FROM,
        to,
        startedAt: now,
        running: outcome === undefined };
    if (outcome !== undefined) {
        operation.result = { outcome,
            finishedAt: now };
    }
    if (outcome === "previewed") {
        operation.preview = { channel: "stable",
            fields: [ "image" ],
            schemaChanges: false };
    }
    return operation;
}
