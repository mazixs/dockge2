import { strict as assert } from "node:assert";
import test from "node:test";
import composerize from "composerize";
import { analyseConversion, parseDockerRunFlags, tokeniseCommand } from "../../common/docker-run-flags";

/**
 * Convert the way the server does, so the tests judge the real output
 * @param command Command to convert
 * @returns Compose file without the generated top level name
 */
function convert(command : string) : string {
    return composerize(command, "", "latest").split("\n").slice(1).join("\n");
}

test("команда разбирается так же, как её читает оболочка", () => {
    assert.deepEqual(
        tokeniseCommand("docker run -d --name web -p 8080:80 nginx"),
        [ "docker", "run", "-d", "--name", "web", "-p", "8080:80", "nginx" ],
    );

    // Кавычки держат пробел внутри значения
    assert.deepEqual(
        tokeniseCommand("docker run -e 'MSG=hello world' nginx"),
        [ "docker", "run", "-e", "MSG=hello world", "nginx" ],
    );

    // Пустая строка в кавычках - это значение, а не отсутствие токена
    assert.deepEqual(tokeniseCommand("docker run -e VAR='' nginx").length, 5);

    // Обратный слэш переносит строку: так люди и вставляют длинные команды
    assert.deepEqual(
        tokeniseCommand("docker run -d \\\n  --name web \\\n  nginx"),
        [ "docker", "run", "-d", "--name", "web", "nginx" ],
    );
});

test("флаги читаются до имени образа, а команда контейнера не разбирается", () => {
    const flags = parseDockerRunFlags("docker run -d -p 8080:80 nginx sh -c 'echo -p not-a-flag'");

    assert.deepEqual(flags, [
        { flag: "-d" },
        { flag: "-p",
            value: "8080:80" },
    ]);
});

test("короткие флаги читаются слитно и группами", () => {
    assert.deepEqual(parseDockerRunFlags("docker run -it -p80:80 nginx"), [
        { flag: "-i" },
        { flag: "-t" },
        { flag: "-p",
            value: "80:80" },
    ]);

    // Группа, где последний флаг требует значения
    assert.deepEqual(parseDockerRunFlags("docker run -dp 8080:80 nginx"), [
        { flag: "-d" },
        { flag: "-p",
            value: "8080:80" },
    ]);

    // Значение через знак равенства
    assert.deepEqual(parseDockerRunFlags("docker run --restart=always nginx"), [
        { flag: "--restart",
            value: "always" },
    ]);
});

test("перенесённые флаги видны в отчёте по настоящему выводу конвертера", () => {
    const command = "docker run -d --name web -p 8080:80 -v /srv/data:/data -e TZ=Europe/Moscow --restart unless-stopped nginx";
    const report = analyseConversion(command, convert(command));

    const carried = report.carried.map((item) => item.flag);
    assert.ok(carried.includes("--name"), `--name не признан перенесённым: ${JSON.stringify(report)}`);
    assert.ok(carried.includes("-p"));
    assert.ok(carried.includes("-v"));
    assert.ok(carried.includes("-e"));
    assert.ok(carried.includes("--restart"));

    // -d описывает поведение docker run, а не сервис: терять нечего
    assert.equal(report.dropped.some((item) => item.flag === "-d"), false);
});

test("флаг, который конвертер не перенёс, попадает в потери", () => {
    // Проверяем на настоящем выводе: если composerize однажды научится
    // переносить --device, тест это заметит и его нужно будет обновить
    const command = "docker run -d --name jellyfin --device /dev/dri:/dev/dri -p 8096:8096 jellyfin/jellyfin";
    const compose = convert(command);
    const report = analyseConversion(command, compose);

    const carriesDevices = /devices:/.test(compose);
    const reported = report.dropped.find((item) => item.flag === "--device");

    if (carriesDevices) {
        assert.equal(reported, undefined, "конвертер перенёс --device, отчёт не должен звать это потерей");
    } else {
        assert.ok(reported, `--device потерян, но в отчёте его нет: ${JSON.stringify(report)}`);
        assert.equal(reported?.value, "/dev/dri:/dev/dri");
        assert.equal(reported?.reason, "flagNoComposeKey");
    }
});

test("отчёт следует за конвертером, а не за нашими предположениями", () => {
    const command = "docker run -d --gpus all --label-file ./labels.txt -P nginx";
    const compose = convert(command);
    const report = analyseConversion(command, compose);
    const dropped = report.dropped.map((item) => item.flag);
    const carried = report.carried.map((item) => item.flag);

    // composerize сам пишет неподдержанный флаг комментарием: это авторитетный отказ
    assert.ok(dropped.includes("--label-file"), `--label-file: ${JSON.stringify(report)}`);
    assert.ok(dropped.includes("-P"), `-P: ${JSON.stringify(report)}`);

    // А --gpus он переносит в deploy.resources, и звать это потерей было бы ложью
    assert.ok(/driver: nvidia/.test(compose), "конвертер перестал переносить --gpus, отчёт надо обновить");
    assert.ok(carried.includes("--gpus"), `--gpus: ${JSON.stringify(report)}`);
});

test("флаги, требующие внимания, не путаются с потерями", () => {
    const command = "docker run -d --name web --env-file ./prod.env --network proxy --rm nginx";
    const compose = convert(command);
    const report = analyseConversion(command, compose);

    const review = report.review.map((item) => item.flag);
    const dropped = report.dropped.map((item) => item.flag);

    // --rm не имеет аналога и должен быть назван потерей, а не тихо исчезнуть
    assert.ok(dropped.includes("--rm"), `--rm не назван: ${JSON.stringify(report)}`);

    // env-file и network требуют взгляда человека, если конвертер их перенёс
    for (const flag of [ "--env-file", "--network" ]) {
        assert.ok(
            review.includes(flag) || dropped.includes(flag),
            `${flag} не попал ни в один список: ${JSON.stringify(report)}`,
        );
    }
});

test("незнакомый флаг не исчезает молча", () => {
    const command = "docker run -d --totally-new-flag value nginx";
    const compose = convert(command);
    const report = analyseConversion(command, compose);

    const unknown = [ ...report.review, ...report.dropped ].find((item) => item.flag === "--totally-new-flag");
    assert.ok(unknown, `незнакомый флаг пропал: ${JSON.stringify(report)}`);
    assert.equal(unknown?.reason, "flagUnknown");
});

test("сломанный YAML не превращает перенесённые флаги в перенесённые", () => {
    // Если конвертер вернул мусор, о переносе судить нельзя: всё уходит в потери
    const report = analyseConversion("docker run -p 8080:80 nginx", "не: [yaml");
    assert.equal(report.carried.length, 0);
    assert.equal(report.dropped.some((item) => item.flag === "-p"), true);
});
