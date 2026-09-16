import { describe, it } from "node:test";
import assert from "node:assert";
import { parseComposeProgress } from "../../common/compose-progress";

/**
 * Вывод взят таким, каким его печатает docker compose в настоящем терминале:
 * с перерисовкой блока, вертушкой, галочками и строками слоев образа.
 */
describe("разбор хода docker compose", () => {
    it("сводит перерисованный блок в один шаг на ресурс", () => {
        const output = [
            "[+] Running 0/2",
            " ⠋ Container paperless-db  Creating                       0.1s",
            " ⠋ Container paperless-web Creating                       0.1s",
            "[+] Running 1/2",
            " ✔ Container paperless-db  Created                        0.2s",
            " ⠙ Container paperless-web Creating                       0.3s",
            "[+] Running 2/2",
            " ✔ Container paperless-db  Started                        0.9s",
            " ✔ Container paperless-web Started                        1.2s",
        ].join("\n");

        const progress = parseComposeProgress(output);

        assert.strictEqual(progress.phase, "running");
        assert.strictEqual(progress.done, 2);
        assert.strictEqual(progress.total, 2);
        assert.strictEqual(progress.failed, false);

        // Два ресурса, а не восемь строк: перерисовка не создает новых шагов
        assert.deepStrictEqual(progress.tasks.map((task) => [ task.name, task.verb, task.state, task.seconds ]), [
            [ "paperless-db", "started", "done", 0.9 ],
            [ "paperless-web", "started", "done", 1.2 ],
        ]);
    });

    it("различает контейнеры, сети, тома и образы", () => {
        const output = [
            "[+] Running 4/4",
            " ✔ Network paperless_default  Created   0.1s",
            " ✔ Volume paperless_data      Created   0.0s",
            " ✔ Container paperless-web    Started   1.2s",
            " ✔ web Pulled                          16.3s",
        ].join("\n");

        const progress = parseComposeProgress(output);

        assert.deepStrictEqual(progress.tasks.map((task) => [ task.kind, task.name ]), [
            [ "network", "paperless_default" ],
            [ "volume", "paperless_data" ],
            [ "container", "paperless-web" ],
            [ "image", "web" ],
        ]);
    });

    it("пропускает слои образа и обычный вывод", () => {
        const output = [
            "[+] Pulling 13/13",
            " ⠇ 5eb5b503b376 Downloading  [====>      ]  12.3MB/48.9MB",
            " ✔ 5eb5b503b376 Pull complete                        2.1s",
            "WARN[0000] /opt/stacks/paperless/compose.yaml: version is obsolete",
            "unable to prepare context: path not found",
            " ✔ web Pulled                                       16.3s",
        ].join("\n");

        const progress = parseComposeProgress(output);

        assert.strictEqual(progress.phase, "pulling");
        assert.deepStrictEqual(progress.tasks.map((task) => task.name), [ "web" ]);
    });

    it("видит провал шага и по кресту, и по слову", () => {
        const output = [
            "[+] Running 1/2",
            " ✔ Container paperless-db   Started   0.9s",
            " ✘ Container paperless-web  Error     0.4s",
        ].join("\n");

        const progress = parseComposeProgress(output);

        assert.strictEqual(progress.failed, true);
        assert.strictEqual(progress.tasks[1]?.state, "failed");
        assert.strictEqual(progress.tasks[1]?.verb, "error");
    });

    it("читает вывод с управляющими последовательностями", () => {
        const output = "[1A[2K[+] Running 1/1\r\n [32m✔[0m Container paperless-web  Started  1.2s\r\n";

        const progress = parseComposeProgress(output);

        assert.strictEqual(progress.done, 1);
        assert.deepStrictEqual(progress.tasks.map((task) => [ task.name, task.state ]), [[ "paperless-web", "done" ]]);
    });

    it("на остановке показывает удаление, а последнее слово о ресурсе побеждает", () => {
        const output = [
            "[+] Running 0/2",
            " ⠋ Container paperless-web    Stopping   0.2s",
            "[+] Running 2/2",
            " ✔ Container paperless-web    Removed    0.6s",
            " ✔ Network paperless_default  Removed    0.1s",
        ].join("\n");

        const progress = parseComposeProgress(output);

        assert.deepStrictEqual(progress.tasks.map((task) => [ task.name, task.verb ]), [
            [ "paperless-web", "removed" ],
            [ "paperless_default", "removed" ],
        ]);
    });

    it("незнакомая вертушка не мешает прочитать шаг", () => {
        // Набор символов вертушки у compose меняется, и знать их все нельзя
        const progress = parseComposeProgress(" \u2b58 Container paperless-web  Creating  0.1s");

        assert.deepStrictEqual(progress.tasks.map((task) => [ task.name, task.verb, task.state ]), [
            [ "paperless-web", "creating", "working" ],
        ]);
    });

    it("пустой вывод не выдумывает шагов", () => {
        const progress = parseComposeProgress("");

        assert.deepStrictEqual(progress, { phase: "",
            done: 0,
            total: 0,
            tasks: [],
            failed: false });
    });
});
