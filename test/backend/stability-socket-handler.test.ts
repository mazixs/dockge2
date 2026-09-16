import { strict as assert } from "node:assert";
import test from "node:test";
import { AgentSocket } from "../../common/agent-socket";
import { StabilitySocketHandler } from "../../backend/agent-socket-handlers/stability-socket-handler";
import type { DockgeServer } from "../../backend/dockge-server";
import { makeAuthenticatedSocket, withDatabase } from "../helpers/database";

interface Response {
    ok? : boolean;
    overview? : { windowHours : number; error : string | null };
}

function call(socket : AgentSocket, period : unknown) : Promise<Response> {
    return new Promise((resolve) => socket.call("stabilityOverview", period, resolve));
}

test("stability overview requires login and rejects unsupported windows", async () => {
    await withDatabase(async () => {
        const socket = new AgentSocket();
        const identity = makeAuthenticatedSocket({ userID: "" });
        new StabilitySocketHandler().create(identity, {} as DockgeServer, socket);
        assert.equal((await call(socket, 24)).ok, false);
        identity.userID = "test-viewer";
        for (const invalid of [ 1, 23, 25, 719, 721, "24", null, NaN ]) {
            assert.equal((await call(socket, invalid)).ok, false);
        }
        for (const period of [ 24, 168, 720 ]) {
            const response = await call(socket, period);
            assert.equal(response.ok, true);
            assert.equal(response.overview?.windowHours, period);
            assert.equal(response.overview?.error, "noObservation");
        }
    });
});
