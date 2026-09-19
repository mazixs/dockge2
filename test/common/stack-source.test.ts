import { strict as assert } from "node:assert";
import test from "node:test";
import { STACK_GIT_STATE_KEY, stackSourceDiffers, stackSourceState, type StackSource } from "../../common/stack-source";

/**
 * Собрать ответ чтения каталога, переопределив только то, что проверяется
 * @param over Поля, отличные от чистой сверенной копии
 * @returns Источник стека
 */
function source(over : Partial<StackSource> = {}) : StackSource {
    return { kind: "git",
        commit: "a".repeat(40),
        changedFiles: 0,
        remote: "example.com/user/stack",
        branch: "main",
        behind: 0,
        dirty: false,
        checkedAt: 1_700_000_000_000,
        ...over };
}

test("каталог без Git состояния Git не получает", () => {
    assert.equal(stackSourceState(null), "local");
    assert.equal(stackSourceState(undefined), "local");
    assert.equal(stackSourceState(source({ kind: "local" })), "local");
});

test("правки на сервере и коммиты в Git названы по отдельности", () => {
    assert.equal(stackSourceState(source({ dirty: true })), "edited");
    assert.equal(stackSourceState(source({ behind: 2 })), "behind");
    assert.equal(stackSourceState(source({ dirty: true,
        behind: 2 })), "editedBehind");
});

test("нулевое отставание называется совпадением только после проверки", () => {
    assert.equal(stackSourceState(source()), "clean");

    // Склонировали и ни разу не спросили origin: расстояние считалось до ссылки
    // времен клона, и называть его совпадением с Git не за что
    assert.equal(stackSourceState(source({ checkedAt: null })), "unchecked");

    // Расстояние неизвестно вовсе - например, у ветви нет upstream
    assert.equal(stackSourceState(source({ behind: null })), "unchecked");
});

test("нечитаемая рабочая копия не стирает того, что известно про Git", () => {
    assert.equal(stackSourceState(source({ dirty: null,
        behind: null })), "unreadable");

    // Статус не прочитался, но отставание прочиталось: молчать про коммиты нельзя
    assert.equal(stackSourceState(source({ dirty: null,
        behind: 3 })), "behind");
});

test("открывать сравнение зовут только расхождения", () => {
    for (const state of [ "edited", "behind", "editedBehind" ] as const) {
        assert.equal(stackSourceDiffers(state), true, state);
    }

    for (const state of [ "local", "clean", "unchecked", "unreadable" ] as const) {
        assert.equal(stackSourceDiffers(state), false, state);
    }
});

test("у каждого состояния Git есть строка в каталоге", () => {
    const keys = Object.values(STACK_GIT_STATE_KEY);

    assert.equal(new Set(keys).size, keys.length, "две строки на одно состояние");

    for (const state of [ "unreadable", "edited", "behind", "editedBehind", "clean", "unchecked" ] as const) {
        assert.equal(typeof STACK_GIT_STATE_KEY[state], "string", state);
    }
});
