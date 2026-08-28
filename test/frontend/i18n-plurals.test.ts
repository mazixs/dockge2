import { strict as assert } from "node:assert";
import test from "node:test";
import { createI18n } from "vue-i18n";
import { russianPluralRule } from "../../frontend/src/i18n";

test("русские формы выбираются по числу, а не по английскому правилу", () => {
    const forms = 3;

    for (const [ count, index ] of [
        [ 1, 0 ], [ 21, 0 ], [ 101, 0 ],
        [ 2, 1 ], [ 3, 1 ], [ 24, 1 ],
        [ 0, 2 ], [ 5, 2 ], [ 11, 2 ], [ 14, 2 ], [ 112, 2 ], [ 25, 2 ],
    ] as const) {
        assert.equal(russianPluralRule(count, forms), index, `${count}`);
    }
});

test("сообщение с двумя формами не выходит за свои границы", () => {
    assert.equal(russianPluralRule(1, 2), 0);
    assert.equal(russianPluralRule(3, 2), 1);
    assert.equal(russianPluralRule(7, 2), 1);
});

test("правило подключено к экземпляру i18n приложения", () => {
    const i18n = createI18n({
        legacy: false,
        locale: "ru",
        messages: {
            ru: { serviceCount: "{count} сервис | {count} сервиса | {count} сервисов" },
        },
        pluralRules: { ru: russianPluralRule },
    });

    const t = i18n.global.t;
    assert.equal(t("serviceCount", 1), "1 сервис");
    assert.equal(t("serviceCount", 2), "2 сервиса");
    assert.equal(t("serviceCount", 5), "5 сервисов");
});
