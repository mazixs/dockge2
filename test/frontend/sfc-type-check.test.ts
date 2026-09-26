import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { DockgeRootApi } from "../../frontend/src/root-api";

/**
 * `vue-tsc` checks a plain `<script>` block only as loosely as `allowJs` does: a call to
 * an agent event could name an event that does not exist, forget its arguments or read a
 * field the answer does not carry, and the check would still pass. Every component moved
 * to TypeScript in 0.0.14; the test below keeps a new one from coming back as JavaScript,
 * and `wrongAgentCallsDoNotCompile` holds that the agent API they call stays strict.
 */

const sources = fileURLToPath(new URL("../../frontend/src/", import.meta.url));

test("every single file component with a script is written in TypeScript", () => {
    const components = readdirSync(sources, { recursive: true,
        encoding: "utf8" }).filter((file) => file.endsWith(".vue"));
    const loose = components.filter((file) => {
        const source = readFileSync(path.join(sources, file), "utf8");
        return /<script[\s>]/.test(source) && !/<script(?: setup)? lang="ts"[\s>]/.test(source);
    });

    assert.ok(components.length > 40, "the components were found");
    assert.deepEqual(loose, [], "a plain <script> block is checked only as loosely as JavaScript");
});

/**
 * Never run: `npm run check-ts` compiles it, and every marked line has to stay an error.
 * If the agent API loosened to `any`, the components would compile a wrong call as well.
 * @param api The root API the components call through `this`
 */
export function wrongAgentCallsDoNotCompile(api : DockgeRootApi) : void {
    // @ts-expect-error the arguments of the event are missing
    void api.emitAgentRequest("", "dockerStats");

    // @ts-expect-error no such event in the agent protocol
    void api.emitAgentRequest("", "dockerStatsList", []);

    void api.emitAgentRequest("", "dockerStats", []).then((res) => {
        if (res.ok) {
            // @ts-expect-error the answer carries dockerStats, not a service list
            return res.serviceStatusList;
        }
    });
}
