import { strict as assert } from "node:assert";
import test from "node:test";
import { gitRepositoryProblem, isSafeGitRepository } from "../../common/git-repository";

test("обычные адреса принимаются", () => {
    for (const repository of [
        "https://github.com/example/app.git",
        "http://git.internal/team/app",
        "ssh://git@example.org/team/app.git",
        "git@example.org:team/app.git",
    ]) {
        assert.equal(gitRepositoryProblem(repository), null, repository);
    }
});

test("адрес, который не адрес, отличается от адреса не того транспорта", () => {
    // Строка, которую git принял бы за ключ командной строки
    assert.equal(gitRepositoryProblem("--upload-pack=touch /tmp/x"), "shape");
    assert.equal(gitRepositoryProblem("https://example.org/a b"), "shape");
    assert.equal(gitRepositoryProblem(`https://example.org/${"a".repeat(2048)}`), "shape");
    assert.equal(gitRepositoryProblem(42), "shape");

    assert.equal(gitRepositoryProblem("file:///etc"), "transport");
    assert.equal(gitRepositoryProblem("ext::sh"), "transport");
    assert.equal(gitRepositoryProblem("https://example.org"), "transport");
    assert.equal(gitRepositoryProblem(""), "transport");
});

test("учетные данные в адресе не принимаются ни в каком виде", () => {
    // Токен в адресе попал бы в каталог стека, в список веток и на экран
    assert.equal(gitRepositoryProblem("https://token@example.org/app"), "transport");
    assert.equal(gitRepositoryProblem("https://user:pass@example.org/app"), "transport");
    assert.equal(gitRepositoryProblem("ssh://git:pass@example.org/app"), "transport");
    assert.equal(gitRepositoryProblem("https://example.org/app?token=secret"), "transport");
    assert.equal(gitRepositoryProblem("https://example.org/app#token"), "transport");

    // Имя пользователя для ssh - это не пароль, а способ входа по ключу хоста
    assert.equal(gitRepositoryProblem("ssh://git@example.org/app"), null);
});

test("сокращенная запись ssh не пропускает путь, который станет ключом", () => {
    assert.equal(gitRepositoryProblem("git@example.org:team/app.git"), null);

    // Раньше страница создания принимала такие адреса, а сервер отказывал: точки
    // с запятой и пробелов в пути быть не может
    assert.equal(isSafeGitRepository("git@example.org:team/app;whoami"), false);
    assert.equal(isSafeGitRepository("git@example.org:team/app app"), false);
});

test("локальный путь разрешается только тому, кто явно об этом попросил", () => {
    assert.equal(gitRepositoryProblem("/srv/repos/app.git"), "transport");
    assert.equal(gitRepositoryProblem("/srv/repos/app.git", true), null);

    // Относительный путь не становится адресом и с разрешением
    assert.equal(gitRepositoryProblem("../app.git", true), "transport");
});
