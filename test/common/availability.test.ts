import { strict as assert } from "node:assert";
import test from "node:test";
import { computeAvailability, isHealthyStatus, MIN_COVERAGE_MS } from "../../common/availability";
import { ATTENTION, CREATED_STACK, EXITED, RUNNING, UNKNOWN } from "../../common/util-common";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;
const DAY = 24 * HOUR;

test("здоровым считается только работающий стек", () => {
    assert.equal(isHealthyStatus(RUNNING), true);
    // Деградация и нечитаемое состояние здоровыми не бывают
    assert.equal(isHealthyStatus(ATTENTION), false);
    assert.equal(isHealthyStatus(UNKNOWN), false);
    assert.equal(isHealthyStatus(EXITED), false);
});

test("окно без наблюдений не становится зеленым", () => {
    const nothing = computeAvailability([], DAY, NOW);
    assert.equal(nothing.verdict, "noData");
    assert.equal(nothing.ratio, null);
    assert.equal(nothing.coveredMs, 0);

    // Наблюдения идут одиннадцать секунд: процента быть не может
    const fresh = computeAvailability([{ status: RUNNING,
        at: NOW - 11_000,
        until: NOW }], DAY, NOW);
    assert.equal(fresh.verdict, "noData");
    assert.equal(fresh.ratio, null);
    assert.equal(fresh.coveredMs, 11_000);
    assert.equal(fresh.currentStatus, RUNNING);
});

test("полное окно без сбоев не превращается в 100 процентов", () => {
    const clean = computeAvailability([{ status: RUNNING,
        at: NOW - 2 * DAY,
        until: NOW }], DAY, NOW);

    assert.equal(clean.verdict, "clean");
    assert.equal(clean.ratio, 1);
    assert.equal(clean.incidents, 0);
    // Состояние началось до окна, поэтому окно закрыто целиком
    assert.equal(clean.coveredMs, DAY);
});

test("сбой уменьшает долю и считается одним случаем, а не выборкой", () => {
    // Сутки: 23 часа работал, час в деградации
    const result = computeAvailability([
        { status: RUNNING,
            at: NOW - 2 * DAY,
            until: NOW },
        { status: ATTENTION,
            at: NOW - 2 * HOUR,
            until: NOW },
        { status: RUNNING,
            at: NOW - HOUR,
            until: NOW },
    ], DAY, NOW);

    assert.equal(result.verdict, "degraded");
    assert.equal(result.incidents, 1);
    assert.ok(Math.abs((result.ratio ?? 0) - 23 / 24) < 0.0001, String(result.ratio));
});

test("две отдельные деградации - два случая", () => {
    const result = computeAvailability([
        { status: RUNNING,
            at: NOW - 2 * DAY,
            until: NOW },
        { status: ATTENTION,
            at: NOW - 10 * HOUR,
            until: NOW },
        { status: RUNNING,
            at: NOW - 9 * HOUR,
            until: NOW },
        { status: ATTENTION,
            at: NOW - 5 * HOUR,
            until: NOW },
        { status: RUNNING,
            at: NOW - 4 * HOUR,
            until: NOW },
    ], DAY, NOW);

    assert.equal(result.incidents, 2);
    assert.equal(result.verdict, "degraded");
});

test("пропуск в наблюдениях уменьшает покрытие, а не создает зеленое время", () => {
    // Агент молчал шесть часов: этих часов в знаменателе нет
    const result = computeAvailability([
        { status: RUNNING,
            at: NOW - DAY,
            until: NOW },
        { status: UNKNOWN,
            at: NOW - 12 * HOUR,
            until: NOW },
        { status: RUNNING,
            at: NOW - 6 * HOUR,
            until: NOW },
    ], DAY, NOW);

    assert.equal(result.coveredMs, 18 * HOUR);
    // Шесть часов без данных не входят в наблюдаемое время
    assert.equal(result.ratio, 1);
    assert.equal(result.incidents, 0);
});

test("остановленный стек не получает процента, а получает срок", () => {
    const result = computeAvailability([
        { status: EXITED,
            at: NOW - 3 * DAY,
            until: NOW },
    ], DAY, NOW);

    assert.equal(result.verdict, "stopped");
    assert.equal(result.ratio, null);
    assert.equal(result.currentForMs, 3 * DAY);
    assert.equal(result.currentStatus, EXITED);
});

test("созданный, но не запущенный стек тоже остановлен, а не деградировал", () => {
    const result = computeAvailability([
        { status: CREATED_STACK,
            at: NOW - 2 * DAY,
            until: NOW },
    ], DAY, NOW);

    assert.equal(result.verdict, "stopped");
});

test("записи из будущего игнорируются, а порядок не важен", () => {
    const shuffled = computeAvailability([
        { status: RUNNING,
            at: NOW - HOUR,
            until: NOW },
        { status: RUNNING,
            at: NOW + HOUR },
        { status: ATTENTION,
            at: NOW - 2 * DAY,
            until: NOW },
    ], DAY, NOW);

    assert.equal(shuffled.currentStatus, RUNNING);
    assert.equal(shuffled.coveredMs, DAY);
});

test("порог покрытия объявлен, а не спрятан в вычислении", () => {
    const justUnder = computeAvailability([{ status: RUNNING,
        at: NOW - MIN_COVERAGE_MS + 1000,
        until: NOW }], DAY, NOW);
    assert.equal(justUnder.verdict, "noData");

    const justOver = computeAvailability([{ status: RUNNING,
        at: NOW - MIN_COVERAGE_MS - 1000,
        until: NOW }], DAY, NOW);
    assert.equal(justOver.verdict, "clean");
});
