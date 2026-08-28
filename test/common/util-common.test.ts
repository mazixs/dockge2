import { strict as assert } from "node:assert";
import test from "node:test";
import { parseDocument } from "yaml";
import {
    CREATED_FILE,
    CREATED_STACK,
    EXITED,
    RUNNING,
    UNKNOWN,
    copyYAMLComments,
    envsubst,
    envsubstYAML,
    genSecret,
    getCombinedTerminalName,
    getComposeTerminalName,
    getContainerExecTerminalName,
    isContainerShell,
    getContainerTerminalName,
    getCryptoRandomInt,
    intHash,
    parseDockerPort,
    sleep,
    ATTENTION,
    statusStateName,
    statusName,
    statusNameShort,
} from "../../common/util-common";

test("status helpers cover all supported statuses", () => {
    assert.deepEqual([
        statusName(UNKNOWN),
        statusName(CREATED_FILE),
        statusName(CREATED_STACK),
        statusName(RUNNING),
        statusName(EXITED),
        statusName(ATTENTION),
        statusName(99),
    ], [ "unknown", "draft", "created_stack", "running", "exited", "attention", "unknown" ]);

    // An unreadable status must never look like a normal inactive stack
    assert.deepEqual([
        statusNameShort(UNKNOWN),
        statusNameShort(CREATED_FILE),
        statusNameShort(CREATED_STACK),
        statusNameShort(RUNNING),
        statusNameShort(EXITED),
        statusNameShort(ATTENTION),
        statusNameShort(99),
    ], [ "unknown", "inactive", "inactive", "active", "exited", "attention", "unknown" ]);

    // Состояние никогда не приходит синим: акцент означает интерактив, а не «работает»
    assert.deepEqual([
        statusStateName(UNKNOWN),
        statusStateName(CREATED_FILE),
        statusStateName(CREATED_STACK),
        statusStateName(RUNNING),
        statusStateName(EXITED),
        statusStateName(ATTENTION),
        statusStateName(99),
    ], [ "unknown", "stopped", "stopped", "running", "failed", "attention", "unknown" ]);
});

test("common naming and hashing helpers are deterministic", () => {
    assert.equal(intHash("abc"), 4);
    assert.equal(intHash("abc", 3), 0);
    assert.equal(intHash("", 10), 0);
    assert.equal(getComposeTerminalName("host", "stack"), "compose-host-stack");
    assert.equal(getCombinedTerminalName("host", "stack"), "combined-host-stack");
    assert.equal(getContainerTerminalName("host", "container"), "container-host-container");
    // The shell is part of the terminal identity, so sh and bash never share a PTY
    assert.equal(getContainerExecTerminalName("host", "stack", "container", "sh", 2), "container-exec-host-stack-container-sh-2");
    assert.equal(getContainerExecTerminalName("host", "stack", "container", "bash"), "container-exec-host-stack-container-bash-0");
    assert.notEqual(
        getContainerExecTerminalName("host", "stack", "container", "sh"),
        getContainerExecTerminalName("host", "stack", "container", "bash"),
    );
    assert.equal(isContainerShell("bash"), true);
    assert.equal(isContainerShell("sh"), true);
    for (const bad of [ "zsh", "bash -c ls", "/bin/sh", "", 5, null ]) {
        assert.equal(isContainerShell(bad), false, `${JSON.stringify(bad)} must be refused`);
    }
});

test("random helpers return values within their contracts", async () => {
    await new Promise<void>((resolve) => {
        setImmediate(resolve);
    });

    assert.equal(genSecret(0), "");
    const secret = genSecret(32);
    assert.equal(secret.length, 32);
    assert.match(secret, /^[A-Za-z0-9]+$/);

    for (let i = 0; i < 100; i++) {
        const value = getCryptoRandomInt(3, 7);
        assert.ok(value >= 3 && value <= 7);
    }

    const started = Date.now();
    await sleep(5);
    assert.ok(Date.now() >= started + 4);
});

test("Docker port parsing handles direct ports, mappings, ranges and protocols", () => {
    assert.deepEqual(parseDockerPort("3000", "localhost"), {
        url: "http://localhost:3000",
        display: "3000",
    });
    assert.deepEqual(parseDockerPort("3000-3005", "localhost"), {
        url: "http://localhost:3000",
        display: "3000-3005",
    });
    assert.deepEqual(parseDockerPort("127.0.0.1:8001:8001", "localhost"), {
        url: "http://127.0.0.1:8001",
        display: "127.0.0.1:8001",
    });
    assert.deepEqual(parseDockerPort("6060:6060/udp", "localhost"), {
        url: "udp://localhost:6060",
        display: "6060",
    });
    assert.deepEqual(parseDockerPort("443:443", "localhost"), {
        url: "https://localhost:443",
        display: "443",
    });
    assert.deepEqual(parseDockerPort("0.0.0.0:8080->8080/tcp", "localhost"), {
        url: "http://localhost:8080",
        display: "8080",
    });
});

test("environment substitution works for strings and YAML values", () => {
    assert.equal(envsubst("hello ${NAME}", { NAME: "Dockge" }), "hello Dockge");

    const source = "services:\n  app:\n    image: ${IMAGE}\n    environment:\n      PORT: ${PORT}\n";
    const substituted = envsubstYAML(source, {
        IMAGE: "nginx:latest",
        PORT: "8080",
    });
    assert.deepEqual(parseDocument(substituted).toJS(), {
        services: {
            app: {
                image: "nginx:latest",
                environment: {
                    PORT: "8080",
                },
            },
        },
    });
});

test("YAML comment copier preserves comments after reordering", () => {
    const source = parseDocument(
        "# services\nservices:\n  # app service\n  app: # app key\n    image: nginx # image\n"
    );
    const target = parseDocument(
        "services:\n  app:\n    image: nginx\n"
    );

    copyYAMLComments(target, source);

    const output = target.toString();
    assert.match(output, /# services/);
    assert.match(output, /# app service/);
    assert.match(output, /# app key/);
    assert.match(output, /# image/);
});

test("YAML comment copier preserves legacy octal mode", () => {
    const source = parseDocument(
        "services:\n  app:\n    volumes:\n      - type: tmpfs\n        target: /cache\n        tmpfs:\n          mode: 01777\n"
    );
    const target = parseDocument(source.toString());

    copyYAMLComments(target, source);

    assert.match(target.toString(), /mode: 01777/);
});

test("YAML comment copier keeps compose strings and plain documents unchanged", () => {
    const source = parseDocument(
        "services:\n  app:\n    restart: on-failure\n    environment:\n      ENABLED: yes\n      DISABLED: no\n    tmpfs:\n      mode: 01777\n"
    );
    const target = parseDocument(source.toString());

    copyYAMLComments(target, source);

    const output = target.toString();
    assert.match(output, /mode: 01777/);

    // Switching the schema must not turn compose strings into booleans
    const reparsed = parseDocument(output).toJS();
    assert.equal(reparsed.services.app.restart, "on-failure");
    assert.equal(reparsed.services.app.environment.ENABLED, "yes");
    assert.equal(reparsed.services.app.environment.DISABLED, "no");

    // A document without octal values keeps its original formatting
    const plainSource = parseDocument("services:\n  app:\n    image: nginx # image\n    replicas: 2\n");
    const plainTarget = parseDocument("services:\n  app:\n    image: nginx\n    replicas: 2\n");
    copyYAMLComments(plainTarget, plainSource);
    assert.equal(plainTarget.toString(), "services:\n  app:\n    image: nginx # image\n    replicas: 2\n");
});
