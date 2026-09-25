import { strict as assert } from "node:assert";
import test from "node:test";
import { describeServices, parseServicePort, readDeclaredUrls } from "../../frontend/src/stack-services";

test("a port is read in both forms compose accepts, and nothing else", () => {
    assert.deepEqual(parseServicePort("8080:80", "panel.example"), { url: "http://panel.example:8080",
        display: "8080" });
    assert.deepEqual(parseServicePort({ target: 80,
        published: 8080 }, "panel.example"), { url: "http://panel.example:8080",
        display: "8080" });

    // A published port bound to one address is opened on that address, not on the panel
    assert.equal(parseServicePort({ target: 80,
        published: 8080,
        host_ip: "10.0.0.5" }, "panel.example")?.url, "http://10.0.0.5:8080");

    // 443 is opened as https, so the browser does not warn about a plain connection
    assert.equal(parseServicePort("443:443", "panel.example")?.url, "https://panel.example:443");

    // A map without a target is not a port: showing it would offer an address that
    // leads nowhere
    assert.equal(parseServicePort({ published: 8080 }, "panel.example"), null);
    assert.equal(parseServicePort(null, "panel.example"), null);
    assert.equal(parseServicePort([ 8080 ], "panel.example"), null);
});

test("a service is listed whether the file declares it or only docker answers for it", () => {
    const config = { services: { app: { image: "nginx",
        ports: [ "8080:80" ] },
    worker: { image: "busybox" } } };
    const statusList = { app: [{ name: "demo-app-1",
        state: "running" }],
    leftover: [{ name: "demo-leftover-1",
        state: "exited",
        issue: "serviceFailed" }] };
    const summary = [{ name: "worker",
        state: "exited",
        isOneShot: true }];

    const services = describeServices(config, statusList, summary, "panel.example");

    assert.deepEqual(services.map((service) => service.name), [ "app", "worker", "leftover" ]);

    const app = services[0];
    assert.equal(app?.running, true);
    assert.equal(app?.state, "running");
    assert.deepEqual(app?.ports, [{ url: "http://panel.example:8080",
        display: "8080" }]);

    // A service the file declares but docker has no container for keeps the state of
    // the stack list, so a stack that was never started still shows its services
    const worker = services[1];
    assert.equal(worker?.instances.length, 0);
    assert.equal(worker?.summaryState, "exited");
    assert.equal(worker?.isOneShot, true);

    // A container of a service the file no longer declares is still shown, with its
    // problem: it is running on the host either way
    const leftover = services[2];
    assert.equal(leftover?.image, "");
    assert.equal(leftover?.state, "failed");
    assert.equal(leftover?.summaryState, "unknown");
});

test("a crashed service reads as failed, a stopped one as stopped, mixed replicas as degraded", () => {
    const state = (instances: { name : string, state : string, issue? : string }[]) => describeServices(null, { app: instances }, [], "panel.example")[0]?.state;

    assert.equal(state([{ name: "app-1",
        state: "exited",
        issue: "serviceFailed" }]), "failed");
    assert.equal(state([{ name: "app-1",
        state: "exited",
        issue: "serviceStopped" }]), "stopped");
    assert.equal(state([{ name: "app-1",
        state: "running" }, { name: "app-2",
        state: "exited",
        issue: "serviceFailed" }]), "attention");
    assert.equal(state([{ name: "app-1",
        state: "running",
        issue: "unhealthy" }]), "attention");
    assert.equal(state([{ name: "app-1",
        state: "",
        issue: "unknownState" }]), "unknown");
});

test("an unreadable compose file leaves the list to docker", () => {
    assert.deepEqual(describeServices(null, {}, [], "panel.example"), []);
    assert.deepEqual(describeServices(undefined, { app: [{ name: "demo-app-1",
        state: "running" }] }, [], "panel.example").map((service) => service.name), [ "app" ]);
});

test("only http links of x-dockge are offered", () => {
    const urls = readDeclaredUrls({ "x-dockge": { urls: [
        "https://panel.example/admin?tab=1",
        "http://panel.example/",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "not a url",
    ] } });

    assert.deepEqual(urls, [
        { url: "https://panel.example/admin?tab=1",
            display: "panel.example/admin?tab=1" },
        { url: "http://panel.example/",
            display: "panel.example" },
    ]);

    assert.deepEqual(readDeclaredUrls({ "x-dockge": { urls: "https://panel.example" } }), []);
    assert.deepEqual(readDeclaredUrls(null), []);
});
