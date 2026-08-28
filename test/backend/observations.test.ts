import { strict as assert } from "node:assert";
import test from "node:test";
import { Database } from "../../backend/database";
import {
    pruneOldObservations,
    readAvailability,
    readChanges,
    recordScan,
    recordStatus,
    resetObservationState,
    RETENTION_MS,
} from "../../backend/observations";
import { ATTENTION, EXITED, RUNNING } from "../../common/util-common";
import { withDatabase } from "../helpers/database";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

test("одинаковый статус второй строки не пишет", async () => {
    await withDatabase(async () => {
        resetObservationState();

        assert.equal(await recordStatus("demo", "", RUNNING, NOW - DAY), true);
        // Ничего не изменилось: история не растёт от того, что крон тикнул
        assert.equal(await recordStatus("demo", "", RUNNING, NOW - HOUR), false);
        assert.equal(await recordStatus("demo", "", ATTENTION, NOW - HOUR), true);

        const rows = await Database.getKnex()("stack_observation").select("status");
        assert.equal(rows.length, 2);
    });
});

test("окно читается вместе с изменением, которое было до него", async () => {
    await withDatabase(async () => {
        resetObservationState();

        // Стек работает месяц: внутри суток изменений нет вообще
        await recordStatus("demo", "", RUNNING, NOW - 30 * DAY);

        const changes = await readChanges("demo", "", DAY, NOW);
        assert.equal(changes.length, 1);
        assert.equal(changes[0]?.status, RUNNING);

        // Без этой записи стек выглядел бы как стек без истории
        const availability = await readAvailability("demo", "", DAY, NOW);
        assert.equal(availability.verdict, "clean");
    });
});

test("история стека агента не смешивается с локальной", async () => {
    await withDatabase(async () => {
        resetObservationState();

        await recordStatus("demo", "", RUNNING, NOW - 2 * DAY);
        await recordStatus("demo", "nas:5001", EXITED, NOW - 2 * DAY);

        assert.equal((await readAvailability("demo", "", DAY, NOW)).verdict, "clean");
        assert.equal((await readAvailability("demo", "nas:5001", DAY, NOW)).verdict, "stopped");
    });
});

test("обход списка пишет только изменившиеся стеки", async () => {
    await withDatabase(async () => {
        resetObservationState();

        const scan = [
            { name: "a",
                endpoint: "",
                status: RUNNING },
            { name: "b",
                endpoint: "",
                status: EXITED },
        ];

        assert.equal(await recordScan(scan, NOW - DAY), 2);
        assert.equal(await recordScan(scan, NOW - HOUR), 0);

        scan[1] = { name: "b",
            endpoint: "",
            status: RUNNING };
        assert.equal(await recordScan(scan, NOW), 1);
    });
});

test("старые записи удаляются, а нужные для окна остаются", async () => {
    await withDatabase(async () => {
        resetObservationState();

        await recordStatus("demo", "", RUNNING, NOW - RETENTION_MS - DAY);
        await recordStatus("demo", "", ATTENTION, NOW - 2 * DAY);

        const removed = await pruneOldObservations(NOW);
        assert.equal(removed, 1);

        const rows = await Database.getKnex()("stack_observation").select("status");
        assert.equal(rows.length, 1);
        assert.equal(Number(rows[0]?.status), ATTENTION);
    });
});

test("сбой в сутках даёт долю и один случай", async () => {
    await withDatabase(async () => {
        resetObservationState();

        await recordStatus("demo", "", RUNNING, NOW - 2 * DAY);
        await recordStatus("demo", "", ATTENTION, NOW - 3 * HOUR);
        await recordStatus("demo", "", RUNNING, NOW - 2 * HOUR);

        const availability = await readAvailability("demo", "", DAY, NOW);
        assert.equal(availability.verdict, "degraded");
        assert.equal(availability.incidents, 1);
        assert.ok((availability.ratio ?? 0) > 0.9, String(availability.ratio));
    });
});
