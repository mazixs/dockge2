import { strict as assert } from "node:assert";
import test from "node:test";
import {
    classifyStackFile,
    isSafeStackFileName,
    looksLikeStackFile,
    pickDefaultComposeFile,
} from "../../common/stack-files";

test("accepted stack file names are classified by kind", () => {
    for (const name of [ "compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", "compose.prod.yaml", "staging.yml" ]) {
        assert.equal(classifyStackFile(name), "compose", `${name} should be a compose file`);
    }

    for (const name of [ ".env", ".env.product", ".env.dev", ".env-test", "production.env" ]) {
        assert.equal(classifyStackFile(name), "env", `${name} should be an env file`);
    }

    for (const name of [ ".secret", ".secret.db", ".secret-db", "db.secret" ]) {
        assert.equal(classifyStackFile(name), "secret", `${name} should be a secret file`);
    }

    // Anything else stays unclassified instead of being treated as a compose file
    for (const name of [ "README.md", "notes.txt", "compose.yaml.bak", "Dockerfile" ]) {
        assert.equal(classifyStackFile(name), null, `${name} should not be accepted`);
    }
});

test("unsafe names are rejected before any path is built", () => {
    const unsafe = [
        "",
        ".",
        "..",
        "../compose.yaml",
        "..\\compose.yaml",
        "/etc/compose.yaml",
        "sub/dir/compose.yaml",
        "C:\\compose.yaml",
        "compose..yaml",
        ".env/../../secret",
        "compose\u0000.yaml",
        "com pose.yaml",
        `${"a".repeat(256)}.yaml`,
    ];

    for (const name of unsafe) {
        assert.equal(isSafeStackFileName(name), false, `${JSON.stringify(name)} must be rejected`);
    }

    for (const name of [ "compose.yaml", ".env.product", ".secret.db", "staging.yml" ]) {
        assert.equal(isSafeStackFileName(name), true, `${name} must be accepted`);
    }
});

test("the default compose file is picked deterministically", () => {
    // The historic order wins, so an existing stack keeps the file it used before
    assert.equal(pickDefaultComposeFile([ "docker-compose.yml", "compose.yaml" ]), "compose.yaml");
    assert.equal(pickDefaultComposeFile([ "docker-compose.yml", "docker-compose.yaml" ]), "docker-compose.yaml");

    // Custom names are sorted, never picked at random
    assert.equal(pickDefaultComposeFile([ "staging.yml", "prod.yaml" ]), "prod.yaml");
    assert.equal(pickDefaultComposeFile([]), "");
});

test("a refused name that was meant as a stack file is recognised", () => {
    // Имя отброшено списком имен, но человек заводил именно файл стека:
    // экран обязан сказать, почему файла нет ни в одном выборе
    for (const name of [ "настройки.env", ".env.локальный", "compose.старый.yaml", "стек.yml", ".secret.ключ", "ключ.secret" ]) {
        assert.equal(looksLikeStackFile(name), true, `${name} should be reported as refused`);
    }

    // Принятое имя попадает в свой список и вторым списком не дублируется
    for (const name of [ "compose.yaml", ".env", ".env.dev", ".secret.db", "staging.yml" ]) {
        assert.equal(looksLikeStackFile(name), false, `${name} is accepted and must not be reported`);
    }

    // Обычные файлы каталога файлами стека никогда не были
    for (const name of [ "README.md", "notes.txt", "Dockerfile", "data", "compose.yaml.bak" ]) {
        assert.equal(looksLikeStackFile(name), false, `${name} was never a stack file`);
    }
});
