import { strict as assert } from "node:assert";
import test from "node:test";
import {
    canonicalFlag,
    DOCKER_RUN_FLAGS,
    parseDockerRun,
    parseDockerRunFlags,
    splitOnce,
    takesValue,
    tokeniseCommand,
} from "../../common/docker-run-flags";

test("a command is split the way a shell reads it", () => {
    assert.deepEqual(
        tokeniseCommand("docker run -d --name web -p 8080:80 nginx"),
        [ "docker", "run", "-d", "--name", "web", "-p", "8080:80", "nginx" ],
    );

    // Quotes keep a space inside the value
    assert.deepEqual(
        tokeniseCommand("docker run -e 'MSG=hello world' nginx"),
        [ "docker", "run", "-e", "MSG=hello world", "nginx" ],
    );

    // An empty quoted string is a value, not a missing token
    assert.deepEqual(tokeniseCommand("docker run -e VAR='' nginx").length, 5);

    // A backslash continues the line: that is how long commands are pasted
    assert.deepEqual(
        tokeniseCommand("docker run -d \\\n  --name web \\\n  nginx"),
        [ "docker", "run", "-d", "--name", "web", "nginx" ],
    );
});

test("flags are read up to the image, and the command of the container is left alone", () => {
    const flags = parseDockerRunFlags("docker run -d -p 8080:80 nginx sh -c 'echo -p not-a-flag'");

    assert.deepEqual(flags, [
        { flag: "-d" },
        { flag: "-p",
            value: "8080:80" },
    ]);

    assert.deepEqual(parseDockerRun("docker run -d -p 8080:80 nginx sh -c 'echo -p not-a-flag'"), {
        flags,
        image: "nginx",
        args: [ "sh", "-c", "echo -p not-a-flag" ],
    });
});

test("short flags are read joined to their value, in groups and with =", () => {
    assert.deepEqual(parseDockerRunFlags("docker run -it -p80:80 nginx"), [
        { flag: "-i" },
        { flag: "-t" },
        { flag: "-p",
            value: "80:80" },
    ]);

    // A group whose last flag takes a value
    assert.deepEqual(parseDockerRunFlags("docker run -dp 8080:80 nginx"), [
        { flag: "-d" },
        { flag: "-p",
            value: "8080:80" },
    ]);

    // docker reads -p=80:80 as 80:80 and -P=false as a switch turned off
    assert.deepEqual(parseDockerRunFlags("docker run -p=8080:80 -P=false nginx"), [
        { flag: "-p",
            value: "8080:80" },
        { flag: "-P",
            value: "false" },
    ]);

    assert.deepEqual(parseDockerRunFlags("docker run --restart=always nginx"), [
        { flag: "--restart",
            value: "always" },
    ]);
});

test("everything before run is skipped", () => {
    for (const command of [ "sudo docker run -d nginx", "docker container run -d nginx", "sudo -E docker run -d nginx" ]) {
        assert.deepEqual(parseDockerRun(command), { flags: [{ flag: "-d" }],
            image: "nginx",
            args: [] }, command);
    }

    // Without run there is nothing to read, and no image
    assert.deepEqual(parseDockerRun("nginx -p 80:80"), { flags: [],
        args: [] });
});

test("an unknown flag with a value does not hide the flags after it", () => {
    // Read as a switch, the value became the image and every flag after it vanished
    const command = "docker run -d --made-up-flag value --label-file ./labels -a stdout nginx";

    assert.deepEqual(parseDockerRunFlags(command), [
        { flag: "-d" },
        { flag: "--made-up-flag",
            value: "value" },
        { flag: "--label-file",
            value: "./labels" },
        { flag: "-a",
            value: "stdout" },
    ]);

    // A switch docker knows never takes the image as its value
    assert.deepEqual(parseDockerRunFlags("docker run --read-only --sig-proxy nginx sh"), [
        { flag: "--read-only" },
        { flag: "--sig-proxy" },
    ]);

    // An unknown flag followed by another flag is a switch, and a negative number is a value
    assert.deepEqual(parseDockerRunFlags("docker run --made-up-switch --memory-swap -1 nginx"), [
        { flag: "--made-up-switch" },
        { flag: "--memory-swap",
            value: "-1" },
    ]);
});

test("an unknown flag that took the image is read again as a switch", () => {
    assert.deepEqual(parseDockerRun("docker run -d --frobnicate nginx"), {
        flags: [{ flag: "-d" }, { flag: "--frobnicate" }],
        image: "nginx",
        args: [],
    });

    // The latest guess is undone first, and the one before it keeps its value
    assert.deepEqual(parseDockerRun("docker run --first on --second nginx"), {
        flags: [{ flag: "--first",
            value: "on" }, { flag: "--second" }],
        image: "nginx",
        args: [],
    });

    // With arguments after the image nothing tells the value from the image: the
    // report shows the flag with the value it took, next to the image it left
    assert.deepEqual(parseDockerRun("docker run --second nginx echo hi"), {
        flags: [{ flag: "--second",
            value: "nginx" }],
        image: "echo",
        args: [ "hi" ],
    });

    // A flag docker knows is never guessed at: a missing image stays missing
    assert.equal(parseDockerRun("docker run -d --name").image, undefined);
});

test("flags are looked up by their long name", () => {
    assert.equal(canonicalFlag("-e"), "--env");
    assert.equal(canonicalFlag("--net"), "--network");
    assert.equal(canonicalFlag("--net-alias"), "--network-alias");
    assert.equal(canonicalFlag("--dns-opt"), "--dns-option");
    assert.equal(canonicalFlag("-x"), "-x");
    assert.equal(canonicalFlag("--made-up"), "--made-up");

    assert.equal(takesValue("-p"), true);
    assert.equal(takesValue("--net"), true);
    assert.equal(takesValue("-d"), false);
    assert.equal(takesValue("--made-up"), false);

    for (const flag of DOCKER_RUN_FLAGS) {
        assert.equal(canonicalFlag(flag), flag, flag);
    }
});

test("a string is split on the first separator only", () => {
    assert.deepEqual(splitOnce("A=B=C", "="), [ "A", "B=C" ]);
    assert.deepEqual(splitOnce("A", "="), [ "A", undefined ]);
    assert.deepEqual(splitOnce("A=", "="), [ "A", "" ]);
});
