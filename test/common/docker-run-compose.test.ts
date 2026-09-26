import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { convertDockerRunCommand, serviceNameFromImage } from "../../common/docker-run-compose";
import { DOCKER_RUN_FLAGS, takesValue, type ConversionReport, type FlagReportItem } from "../../common/docker-run-flags";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A converted command, parsed back, with its report */
interface Converted {
    text : string;
    service : Record<string, unknown>;
    compose : Record<string, unknown>;
    report : ConversionReport;
}

/**
 * Convert a command and read the file back
 * @param command Command to convert
 * @returns The file as text and parsed, and the report
 */
function convert(command : string) : Converted {
    const result = convertDockerRunCommand(command);

    assert.ok(result, command);

    const compose = parse(result.compose) as Record<string, unknown>;
    const services = compose.services as Record<string, Record<string, unknown>>;
    const [ service ] = Object.values(services);

    assert.equal(Object.keys(services).length, 1, result.compose);
    return { text: result.compose,
        service: service as Record<string, unknown>,
        compose,
        report: result.report };
}

/**
 * Every line of a report, whatever its outcome
 * @param report Report of one conversion
 * @returns Lines in the order carried, review, dropped
 */
function lines(report : ConversionReport) : FlagReportItem[] {
    return [ ...report.carried, ...report.review, ...report.dropped ];
}

/**
 * The line of the report about one flag
 * @param report Report of one conversion
 * @param flag Flag as it was written
 * @returns The line, which the test requires to exist
 */
function line(report : ConversionReport, flag : string) : FlagReportItem {
    const found = lines(report).find((item) => item.flag === flag);

    assert.ok(found, `${flag}: ${JSON.stringify(report)}`);
    return found;
}

test("every flag docker knows is carried or named with a reason", () => {
    for (const flag of DOCKER_RUN_FLAGS) {
        const command = `docker run ${flag}${takesValue(flag) ? " x" : ""} nginx`;
        const result = convertDockerRunCommand(command);

        assert.ok(result, command);

        const item = line(result.report, flag);

        assert.notEqual(item.reason, "flagUnknown", command);
        assert.ok(item.outcome === "carried" || item.reason, `${command}: ${JSON.stringify(item)}`);
        assert.equal((parse(result.compose) as { services : Record<string, { image : string }> }).services.nginx?.image, "nginx", command);
    }
});

test("every reason of the report is in the English and Russian catalogues", () => {
    const source = readFileSync(path.join(root, "common", "docker-run-compose.ts"), "utf8");
    const reasons = new Set([ ...source.matchAll(/"(flag[A-Z][A-Za-z]*)"/g) ].map((match) => match[1] as string));

    assert.ok(reasons.size > 10, [ ...reasons ].join(", "));

    for (const language of [ "en", "ru" ]) {
        const catalogue = JSON.parse(readFileSync(path.join(root, "frontend", "src", "lang", `${language}.json`), "utf8")) as Record<string, string>;

        for (const reason of [ ...reasons, "dockerRunNoImage" ]) {
            assert.equal(typeof catalogue[reason], "string", `${language}.json: ${reason}`);
        }
    }
});

test("a command without an image converts to nothing", () => {
    assert.equal(convertDockerRunCommand(""), undefined);
    assert.equal(convertDockerRunCommand("docker run -d -p 80:80"), undefined);
    assert.equal(convertDockerRunCommand("nginx"), undefined);
});

test("the service is named after the image", () => {
    assert.equal(serviceNameFromImage("nginx"), "nginx");
    assert.equal(serviceNameFromImage("nginx:1.27"), "nginx");
    assert.equal(serviceNameFromImage("ghcr.io/example/my_app:2"), "my_app");
    assert.equal(serviceNameFromImage("registry.example.test:5000/team/api"), "api");
    assert.equal(serviceNameFromImage("example/app@sha256:0123"), "app");
    assert.equal(serviceNameFromImage("Example/My App"), "my-app");
    assert.equal(serviceNameFromImage("---"), "app");
});

test("nothing is added that the command did not ask for", () => {
    const { compose, service } = convert("docker run nginx");

    assert.deepEqual(compose, { services: { nginx: { image: "nginx" } } });
    assert.equal("container_name" in service, false);

    assert.equal(convert("docker run --name web nginx").service.container_name, "web");
});

test("YAML 1.1 words and numbers stay strings, and long values are not folded", () => {
    const long = "x".repeat(200);
    const { text, service } = convert(`docker run --restart no -p 22:22 -e FLAG=on -e 'LONG=${long} ${long}' alpine echo yes 0755`);

    assert.ok(text.includes("restart: \"no\""), text);
    assert.ok(text.includes("- \"22:22\""), text);
    assert.ok(text.includes("- \"yes\""), text);
    assert.ok(text.includes("- \"0755\""), text);
    assert.ok(text.includes(`- LONG=${long} ${long}\n`), text);
    assert.deepEqual(service.command, [ "echo", "yes", "0755" ]);
});

test("the flags of a common command are carried in the order they were written", () => {
    const command = "docker run -d --name web -p 8080:80 -v /srv/data:/data -e TZ=Europe/Amsterdam --restart unless-stopped nginx";
    const { service, report } = convert(command);

    assert.deepEqual(Object.keys(service), [ "image", "container_name", "ports", "volumes", "environment", "restart" ]);
    assert.deepEqual(report.carried.map((item) => item.flag), [ "-d", "--name", "-p", "-v", "-e", "--restart" ]);
    assert.equal(line(report, "-d").reason, "flagNotNeeded");
    assert.deepEqual(report.review, []);
    assert.deepEqual(report.dropped, []);
});

test("the report tells what needs a look from what is lost", () => {
    const { service, report } = convert("docker run -d --env-file ./prod.env --network proxy --rm --label-file ./labels -P --frobnicate on nginx");

    assert.deepEqual(report.review.map((item) => [ item.flag, item.reason ]), [
        [ "--env-file", "flagEnvFileMustExist" ],
        [ "--network", "flagNetworkExternal" ],
        [ "--rm", "flagRmNotApplicable" ],
        [ "--label-file", "flagLabelFileMustExist" ],
    ]);
    assert.deepEqual(report.dropped.map((item) => [ item.flag, item.value, item.reason ]), [
        [ "-P", undefined, "flagPublishAllDropped" ],
        [ "--frobnicate", "on", "flagUnknown" ],
    ]);
    assert.equal("frobnicate" in service, false);
});

test("a switch turned off asks for nothing", () => {
    const { service, report } = convert("docker run --privileged=false --init=false --rm=false -P=false --tty=0 nginx");

    assert.deepEqual(service, { image: "nginx" });
    assert.deepEqual(report.carried.map((item) => item.reason), [ "flagNotNeeded", "flagNotNeeded", "flagNotNeeded", "flagNotNeeded", "flagNotNeeded" ]);

    assert.equal(line(convert("docker run --init=maybe nginx").report, "--init").reason, "flagNotAccepted");
});

test("a value docker would refuse is reported, not written", () => {
    const refused = [
        "--cpus abc", "--cpu-shares 1.5", "--ulimit nofile", "--ulimit nofile=a:b", "--ulimit =1",
        "--health-retries x", "--log-opt novalue", "--storage-opt =1", "--stop-timeout 30s",
        "--mount type=bind,source=/a", "--mount type=bind,target=/b,readonly=maybe",
        "--mount type=bind,target=/b,bind-propagation", "--network ''", "--network alias=web",
    ];

    for (const flags of refused) {
        const { service, report } = convert(`docker run ${flags} nginx`);

        assert.deepEqual(service, { image: "nginx" }, flags);
        assert.equal(report.dropped[0]?.reason, "flagNotAccepted", `${flags}: ${JSON.stringify(report)}`);
    }
});

test("--mount becomes the long syntax, and an option compose has no place for is reported", () => {
    const { service, compose, report } = convert("docker run "
        + "--mount type=bind,src=/srv,dst=/srv,ro=true,bind-propagation=rshared,consistency=cached "
        + "--mount type=volume,source=data,target=/data,volume-nocopy "
        + "--mount type=tmpfs,destination=/cache,tmpfs-size=65536 "
        + "--mount 'type=bind,\"source=/a,b\",target=/c,readonly=false' "
        + "--mount type=volume,source=cache,target=/cache,volume-driver=local nginx");

    assert.deepEqual(service.volumes, [
        { type: "bind",
            source: "/srv",
            target: "/srv",
            read_only: true,
            consistency: "cached",
            bind: { propagation: "rshared" } },
        { type: "volume",
            source: "data",
            target: "/data",
            volume: { nocopy: true } },
        { type: "tmpfs",
            target: "/cache",
            tmpfs: { size: 65536 } },
        { type: "bind",
            source: "/a,b",
            target: "/c" },
        { type: "volume",
            source: "cache",
            target: "/cache" },
    ]);
    assert.deepEqual(compose.volumes, {
        data: { external: true,
            name: "data" },
        cache: { external: true,
            name: "cache" },
    });
    assert.deepEqual(lines(report).map((item) => item.reason), [ undefined, undefined, undefined, "flagVolumeExternal", "flagOptionsLost" ]);
});

test("-v declares a named volume and leaves paths and anonymous volumes alone", () => {
    const { service, compose, report } = convert("docker run -v data:/data:ro -v ./conf:/conf -v /cache -v '$PWD:/app' nginx");

    assert.deepEqual(service.volumes, [ "data:/data:ro", "./conf:/conf", "/cache", "$PWD:/app" ]);
    assert.deepEqual(compose.volumes, { data: { external: true,
        name: "data" } });
    assert.deepEqual(lines(report).map((item) => item.reason), [ undefined, undefined, "flagVolumeExternal", "flagDollarInterpolated" ]);
});

test("--gpus becomes a device reservation, and a request it cannot read is reported", () => {
    const reservation = (flags : string) => {
        const { service } = convert(`docker run ${flags} nginx`);
        return (service.deploy as { resources : { reservations : { devices : unknown[] } } }).resources.reservations.devices;
    };

    assert.deepEqual(reservation("--gpus all"), [{ driver: "nvidia",
        count: "all",
        capabilities: [ "gpu" ] }]);
    assert.deepEqual(reservation("--gpus 2"), [{ driver: "nvidia",
        count: 2,
        capabilities: [ "gpu" ] }]);
    assert.deepEqual(reservation("--gpus '\"device=0,2\",driver=amd,\"capabilities=gpu,compute\"'"), [{ driver: "amd",
        device_ids: [ "0", "2" ],
        capabilities: [ "gpu", "compute" ] }]);
    assert.deepEqual(reservation("--gpus driver=nvidia"), [{ driver: "nvidia",
        capabilities: [ "gpu" ] }]);

    for (const value of [ "some", "count=x", "size=2" ]) {
        const { service, report } = convert(`docker run --gpus ${value} nginx`);

        assert.equal("deploy" in service, false, value);
        assert.equal(report.dropped[0]?.reason, "flagGpusDropped", value);
    }
});

test("network flags are worked out together", () => {
    // A mode excludes every network, as docker does
    const mode = convert("docker run --net container:db --network-alias web --ip 10.0.0.2 --network proxy nginx");

    assert.equal(mode.service.network_mode, "container:db");
    assert.equal("networks" in mode.service, false);
    assert.equal("networks" in mode.compose, false);
    assert.deepEqual(mode.report.dropped.map((item) => item.reason), [ "flagNotAccepted", "flagNotAccepted", "flagNotAccepted" ]);

    // Aliases and addresses belong to the first named network, and a network named twice joins once
    const named = convert("docker run --network-alias web --network front --ip6 fd00::5 --network back --net-alias api --network front nginx");

    assert.deepEqual(named.service.networks, {
        front: { aliases: [ "web", "api" ],
            ipv6_address: "fd00::5" },
        back: {},
    });
    assert.deepEqual(Object.keys(named.compose.networks as object), [ "front", "back" ]);
    assert.deepEqual(Object.keys(named.service), [ "image", "networks" ]);

    // The advanced syntax, with an option the service cannot hold
    const advanced = convert("docker run --network name=proxy,alias=a,alias=b,ip6=fd00::6,driver-opt=x nginx");

    assert.deepEqual(advanced.service.networks, { proxy: { aliases: [ "a", "b" ],
        ipv6_address: "fd00::6" } });
    assert.equal(advanced.report.dropped[0]?.reason, "flagOptionsLost");

    // Without a named network an address has nowhere to go
    const address = convert("docker run --ip 172.17.0.5 --ip6 fd00::7 nginx");

    assert.deepEqual(address.service, { image: "nginx" });
    assert.deepEqual(address.report.dropped.map((item) => item.reason), [ "flagIpNeedsNetwork", "flagIpNeedsNetwork" ]);
});

test("a $ in the image or the command of the container is named in the report", () => {
    const { report } = convert("docker run -e 'A=$$escaped' 'nginx:$TAG' echo '$HOME'");

    assert.deepEqual(report.carried.map((item) => item.flag), [ "-e" ]);
    assert.deepEqual(report.review.map((item) => [ item.flag, item.value, item.reason ]), [
        [ "image", "nginx:$TAG", "flagDollarInterpolated" ],
        [ "command", "echo $HOME", "flagDollarInterpolated" ],
    ]);
});

test("the rest of the flags land in their compose keys", () => {
    const { service, report } = convert("docker run --entrypoint '' --stop-timeout 10 --volumes-from data:ro "
        + "--log-driver syslog --log-opt tag=web --tmpfs /run --tmpfs /tmp --no-healthcheck --memory-swap -1 "
        + "--attach stdout --detach-keys ctrl-x --sig-proxy=false -q --disable-content-trust --cidfile /x --umask 0022 --kernel-memory 1g "
        + "--link db --annotation a=b nginx");

    assert.deepEqual(service.entrypoint, []);
    assert.equal(service.stop_grace_period, "10s");
    assert.deepEqual(service.volumes_from, [ "container:data:ro" ]);
    assert.deepEqual(service.logging, { driver: "syslog",
        options: { tag: "web" } });
    assert.deepEqual(service.tmpfs, [ "/run", "/tmp" ]);
    assert.deepEqual(service.healthcheck, { disable: true });
    assert.equal(service.memswap_limit, -1);
    assert.deepEqual(report.dropped.map((item) => [ item.flag, item.reason ]), [
        [ "--cidfile", "flagNoComposeKey" ],
        [ "--umask", "flagNoComposeKey" ],
        [ "--kernel-memory", "flagNoComposeKey" ],
        [ "--link", "flagNotConverted" ],
        [ "--annotation", "flagNotConverted" ],
    ]);
    assert.deepEqual(report.carried.filter((item) => item.reason === "flagNotNeeded").map((item) => item.flag), [
        "--attach", "--detach-keys", "--sig-proxy", "-q", "--disable-content-trust",
    ]);
});
