import { strict as assert } from "node:assert";
import test from "node:test";
import { composeArgs } from "../../backend/compose-args";

test("порядок аргументов один и тот же, чем бы ни был вызов", () => {
    assert.deepEqual(composeArgs({ composeFileName: "compose.yaml",
        envFileNames: [ ".env", ".env.prod" ],
        globalEnvFile: "../global.env" }, "up", "-d", "--remove-orphans"), [
        "compose",
        "--env-file", "../global.env",
        "--env-file", "./.env",
        "--env-file", "./.env.prod",
        "-f", "compose.yaml",
        "up", "-d", "--remove-orphans",
    ]);
});

test("общий env-файл необязателен, и без него ничего не подставляется", () => {
    assert.deepEqual(composeArgs({ composeFileName: "compose.yaml",
        envFileNames: [],
        globalEnvFile: "" }, "config", "--quiet"), [
        "compose", "-f", "compose.yaml", "config", "--quiet",
    ]);
});

test("проверка результата из Git идет под своим именем проекта", () => {
    const args = composeArgs({ composeFileName: "docker-compose.yml",
        envFileNames: [ ".env" ],
        globalEnvFile: "/opt/stacks/global.env",
        projectName: "dockge-git-validation" }, "config", "--quiet");

    // Имя проекта стоит перед подкомандой: иначе оно относилось бы к config
    assert.deepEqual(args.slice(0, 3), [ "compose", "--project-name", "dockge-git-validation" ]);
    assert.ok(!args.includes("up"));
});

test("имя файла остается именем файла, даже если начинается с дефиса", () => {
    const args = composeArgs({ composeFileName: "compose.yaml",
        envFileNames: [ "-f" ],
        globalEnvFile: "" }, "config");

    assert.ok(args.includes("./-f"), args.join(" "));
    assert.ok(!args.includes("-f-f"), args.join(" "));
});
