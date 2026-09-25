import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { DockgeRootApi } from "../../frontend/src/root-api";

/**
 * `allowJs` without `checkJs` compiles a single file component but never looks inside its
 * own methods, so a call to an agent event could name an event that does not exist, forget
 * its arguments or read a field the answer does not carry, and the check would still pass.
 * What turns checking on is `// @ts-check` at the top of the script block, one file at a
 * time. The test below holds that the components which write stacks still ask for the
 * check; `wrongAgentCallsDoNotCompile` holds that the agent API they call stays strict.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Where a wrong agent call has to be caught: the inspector, the editor and the writing screens */
const CHECKED_COMPONENTS = [
    "frontend/src/pages/StackInspector.vue",
    "frontend/src/pages/Compose.vue",
    "frontend/src/pages/NewStack.vue",
    "frontend/src/pages/StackGitChanges.vue",
    "frontend/src/components/CreateStackSheet.vue",
];

test("the components that read and write stacks ask for their own script to be checked", () => {
    for (const file of CHECKED_COMPONENTS) {
        const source = readFileSync(root + file, "utf8");
        const script = source.split("\n<script>\n")[1];

        assert.ok(script, `${file}: a plain <script> block is what // @ts-check applies to`);

        const firstLine = script.split("\n").find((line) => line.trim() !== "");

        assert.equal(firstLine?.trim(), "// @ts-check",
            `${file}: without // @ts-check its own methods are compiled but never checked`);
    }
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
