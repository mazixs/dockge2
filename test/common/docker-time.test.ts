import { strict as assert } from "node:assert";
import test from "node:test";
import { isUpStatus, parseDockerDuration } from "../../common/docker-time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("длительность читается из настоящих фраз докера", () => {
    assert.equal(parseDockerDuration("Up 2 minutes"), 2 * MINUTE);
    assert.equal(parseDockerDuration("Up About a minute"), MINUTE);
    assert.equal(parseDockerDuration("Up About an hour"), HOUR);
    assert.equal(parseDockerDuration("Up 3 hours (healthy)"), 3 * HOUR);
    assert.equal(parseDockerDuration("Up 12 days"), 12 * DAY);
    assert.equal(parseDockerDuration("Up Less than a second"), 1000);
    assert.equal(parseDockerDuration("Exited (137) 4 minutes ago"), 4 * MINUTE);
    assert.equal(parseDockerDuration("Restarting (1) 2 seconds ago"), 2000);
    assert.equal(parseDockerDuration("Up 2 weeks"), 14 * DAY);
});

test("фраза без длительности не превращается в число", () => {
    // «Created» ничего не говорит о времени, и выдумывать его нельзя
    assert.equal(parseDockerDuration("Created"), null);
    assert.equal(parseDockerDuration(""), null);
    assert.equal(parseDockerDuration("Up"), null);
});

test("работающий контейнер отличается от вышедшего по той же строке", () => {
    assert.equal(isUpStatus("Up 2 minutes"), true);
    assert.equal(isUpStatus("up 2 minutes"), true);
    assert.equal(isUpStatus("Exited (0) 2 minutes ago"), false);
    assert.equal(isUpStatus("Created"), false);
});
