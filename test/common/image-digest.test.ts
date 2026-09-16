import { strict as assert } from "node:assert";
import test from "node:test";
import { isNewerImage, parseLocalRepoDigest, parseRemoteDigest, parseSingleManifestDigest } from "../../common/image-digest";

const DIGEST = "sha256:c4717a8d1f0134a7444e24f881160e033991f23027c6c5a9a3f8fd22e70d1d44";
const OTHER = "sha256:80f8bb74f634d45d55967820a702c5fddf01cf92968bb29ed7a3573dd16b0e55";

test("локальный отпечаток берется из RepoDigests своего репозитория", () => {
    const raw = JSON.stringify([ `other/image@${OTHER}`, `traefik/whoami@${DIGEST}` ]);
    assert.equal(parseLocalRepoDigest(raw, "traefik/whoami:latest"), DIGEST);

    // Реестр с портом: двоеточие в нем - не тег
    assert.equal(
        parseLocalRepoDigest(JSON.stringify([ `localhost:5000/app@${DIGEST}` ]), "localhost:5000/app:dev"),
        DIGEST,
    );
});

test("образ без записи о реестре отпечатка не имеет", () => {
    // Собранный локально образ никогда не приходил из реестра
    assert.equal(parseLocalRepoDigest("[]", "app:dev"), null);
    assert.equal(parseLocalRepoDigest("не json", "app:dev"), null);
    assert.equal(parseLocalRepoDigest(JSON.stringify([ "app@мусор" ]), "app:dev"), null);
});

test("ответ buildx читается вместе с кавычками", () => {
    assert.equal(parseRemoteDigest(`"${DIGEST}"\n`), DIGEST);
    assert.equal(parseRemoteDigest(DIGEST), DIGEST);
    assert.equal(parseRemoteDigest("ошибка"), null);
});

test("запасной путь работает только для одноархитектурного образа", () => {
    const single = JSON.stringify([{ Descriptor: { digest: DIGEST } }]);
    assert.equal(parseSingleManifestDigest(single), DIGEST);

    // Мультиархитектурный ответ сравнивать не с чем: локально лежит отпечаток индекса
    const multi = JSON.stringify([{ Descriptor: { digest: DIGEST } }, { Descriptor: { digest: OTHER } }]);
    assert.equal(parseSingleManifestDigest(multi), null);
    assert.equal(parseSingleManifestDigest("не json"), null);
});

test("вывод делается только когда известны оба отпечатка", () => {
    assert.equal(isNewerImage(DIGEST, OTHER), true);
    assert.equal(isNewerImage(DIGEST, DIGEST), false);
    // Образ не скачан или реестр недоступен: это "неизвестно", а не "обновлений нет"
    assert.equal(isNewerImage(null, OTHER), null);
    assert.equal(isNewerImage(DIGEST, null), null);
});
