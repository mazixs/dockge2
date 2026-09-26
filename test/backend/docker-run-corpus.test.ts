import { strict as assert } from "node:assert";
import test from "node:test";
import { parse } from "yaml";
import { convertDockerRun } from "../../backend/socket-handlers/main-socket-handler";
import type { FlagReportItem } from "../../common/docker-run-flags";
import { loadDockerRunCorpus } from "../helpers/docker-run-corpus";

const corpus = loadDockerRunCorpus();

/** Flags that ask for a network, the only reason a network may appear in the output */
const NETWORK_FLAGS = /(^|\s)--(net|network|network-alias|ip|ip6)(\s|=)/;

/**
 * Report items in the shape a fixture records them
 * @param items Items of one outcome
 * @returns Flag and reason of each item
 */
function flagsAndReasons(items : FlagReportItem[]) : { flag : string, reason : string | undefined }[] {
    return items.map((item) => ({ flag: item.flag,
        reason: item.reason }));
}

test("the corpus covers every case the plan names", () => {
    const names = new Set(corpus.map((fixture) => fixture.name));
    const required = [
        "ports", "volumes-bind", "volumes-named", "mount-readonly", "env", "env-file", "restart", "user",
        "network-named", "network-host", "healthcheck", "read-only", "capabilities", "devices", "gpus-all",
        "gpus-devices", "labels", "init", "entrypoint", "command-args", "unknown-flag", "privileged",
        // The cases the former converter lost, kept so that none of them comes back
        "mount-short-keys", "tmpfs-repeated", "network-repeated", "network-alias-default", "stop-timeout",
        "volumes-from", "entrypoint-reset", "label-file", "publish-all", "run-behaviour",
        "unknown-flag-before-image",
    ];

    for (const name of required) {
        assert.ok(names.has(name), `test/fixtures/docker-run/${name}.json is missing`);
    }
});

for (const fixture of corpus) {
    test(`docker run corpus: ${fixture.name}`, () => {
        const { compose: output, report } = convertDockerRun(fixture.command);
        const compose = parse(output) as Record<string, unknown>;
        const services = compose.services as Record<string, Record<string, unknown>>;
        const service = services[fixture.compose.service];

        // Nothing may be added that the command did not ask for
        assert.equal(output.includes("<your project name>"), false, output);
        assert.deepEqual(Object.keys(compose), fixture.compose.topLevel, output);
        assert.deepEqual(Object.keys(services), [ fixture.compose.service ], output);
        assert.ok(service, output);
        assert.deepEqual(Object.keys(service), fixture.compose.keys, output);
        assert.equal("version" in compose, false, output);

        if (!fixture.command.includes("--privileged")) {
            assert.equal("privileged" in service, false, output);
        }

        if (!NETWORK_FLAGS.test(fixture.command)) {
            assert.equal("networks" in compose, false, output);
            assert.equal("networks" in service, false, output);
        }

        for (const [ key, value ] of Object.entries(fixture.compose.values)) {
            assert.deepEqual(service[key], value, `${key}:\n${output}`);
        }

        for (const [ key, value ] of Object.entries(fixture.compose.topLevelValues ?? {})) {
            assert.deepEqual(compose[key], value, `${key}:\n${output}`);
        }

        for (const text of fixture.compose.text ?? []) {
            assert.ok(output.includes(text), `${text}:\n${output}`);
        }

        // The report has to name every loss the fixture records, and only those
        const detail = JSON.stringify(report);

        assert.deepEqual(report.carried.map((item) => item.flag), fixture.report.carried, detail);
        assert.deepEqual(flagsAndReasons(report.review), fixture.report.review, detail);
        assert.deepEqual(flagsAndReasons(report.dropped), fixture.report.dropped, detail);

        const verdict = report.dropped.length > 0 ? "lost" : report.review.length > 0 ? "warned" : "kept";
        assert.equal(verdict, fixture.verdict, detail);
    });
}
