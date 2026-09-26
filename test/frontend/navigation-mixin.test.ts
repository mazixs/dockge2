import { strict as assert } from "node:assert";
import test from "node:test";
import { nextTick, reactive } from "vue";
import navigation from "../../frontend/src/mixins/navigation";
import { mountOptions } from "../helpers/vue-instance";

type Navigation = InstanceType<typeof navigation>;

/** The part of the router the mixin reads */
interface Route {
    path : string;
    params : Record<string, unknown>;
}

/**
 * The navigation mixin with a route the test moves
 * @param path Route the page opens on
 * @param params Parameters of that route
 * @returns The instance, and the route to move
 */
function openAt(path : string, params : Record<string, unknown> = {}) {
    const route = reactive<Route>({ path,
        params });
    const mounted = mountOptions<Navigation>({ mixins: [ navigation ] }, { $route: route });
    return { ...mounted,
        route,
        /**
         * Navigate, and let the watcher run as it does before the next render
         * @param to Path of the new route
         * @param toParams Parameters of the new route
         */
        async go(to : string, toParams : Record<string, unknown> = {}) {
            route.path = to;
            route.params = toParams;
            await nextTick();
        } };
}

test("a stack route opened directly selects its endpoint before anything renders", () => {
    for (const prefix of [ "stack", "compose", "terminal" ]) {
        const page = openAt(`/${prefix}/web/remote-1`, { stackName: "web",
            endpoint: "remote-1" });
        assert.equal(page.vm.selectedEndpoint, "remote-1", prefix);
        page.unmount();
    }
});

test("a stack route without an endpoint selects the local server", () => {
    const page = openAt("/compose/web", { stackName: "web" });
    assert.equal(page.vm.selectedEndpoint, "");
    page.unmount();
});

test("an endpoint parameter that is not a single value selects the local server", () => {
    const page = openAt("/stack/web/x", { endpoint: [ "remote-1", "remote-2" ] });
    assert.equal(page.vm.selectedEndpoint, "");
    page.unmount();
});

test("only a stack route picks the endpoint, every other route keeps the selection", async () => {
    const page = openAt("/stack/web/remote-1", { endpoint: "remote-1" });

    for (const path of [ "/", "/new", "/compose", "/settings/agents", "/stacks/remote-2", "/console/remote-2" ]) {
        await page.go(path, { endpoint: "remote-2" });
        assert.equal(page.vm.selectedEndpoint, "remote-1", path);
    }

    await page.go("/terminal/web/db/bash/remote-2", { endpoint: "remote-2" });
    assert.equal(page.vm.selectedEndpoint, "remote-2");
    await page.go("/compose/web", {});
    assert.equal(page.vm.selectedEndpoint, "");
    assert.deepEqual(page.errors, []);
    page.unmount();
});

test("choosing all servers is not overridden by opening a stack", async () => {
    const page = openAt("/");
    page.vm.selectedEndpoint = null;

    await page.go("/compose/web/remote-1", { endpoint: "remote-1" });
    assert.equal(page.vm.selectedEndpoint, null);
    page.unmount();
});

test("the create sheet and its seed start empty until a layout offers them", () => {
    const page = openAt("/");
    assert.equal(page.vm.openCreateStack, null);
    assert.equal(page.vm.createStackSeed, "");
    page.unmount();
});
