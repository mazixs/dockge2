import { strict as assert } from "node:assert";
import test from "node:test";
import { formatDuration, formatPercent } from "../../frontend/src/format";

/**
 * Перевод, который просто показывает, что получил: тест проверяет выбор единицы,
 * а не сами формулировки
 * @param key Ключ
 * @param count Число
 * @returns Ключ с числом
 */
const t = (key : string, count : number) => `${key}:${count}`;

test("доля превращается в процент с одним знаком", () => {
    // Язык передается явно, поэтому запись не зависит от машины
    assert.equal(formatPercent(0.942, "en"), "94.2%");
    assert.equal(formatPercent(0.942, "ru"), "94,2%");
    assert.equal(formatPercent(1, "en"), "100%");
    // Доступность округляется вниз: простой был, значит "100%" писать нельзя
    assert.equal(formatPercent(0.9996, "en", true), "99.9%");
    assert.equal(formatPercent(0.9996, "en"), "100%");
    // Доли нет - и процента нет, а не "0%"
    assert.equal(formatPercent(null), "");
    assert.equal(formatPercent(undefined), "");
});

test("длительность называется той единицей, которую назвал бы человек", () => {
    assert.equal(formatDuration(6 * 60_000, t), "durationMinutes:6");
    // Меньше минуты - это все равно минута, а не "0 мин"
    assert.equal(formatDuration(4_000, t), "durationMinutes:1");
    assert.equal(formatDuration(3 * 3_600_000, t), "durationHours:3");
    assert.equal(formatDuration(3 * 24 * 3_600_000, t), "durationDays:3");
    // Сутки минус минута еще считаются часами
    assert.equal(formatDuration(24 * 3_600_000 - 60_000, t), "durationHours:23");
    assert.equal(formatDuration(null, t), "");
    assert.equal(formatDuration(-5, t), "");
});
