import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const TOKENS_PATH = path.join(process.cwd(), "frontend/src/styles/tokens.scss");
const VARS_PATH = path.join(process.cwd(), "frontend/src/styles/vars.scss");

/**
 * Relative luminance of an sRGB colour, as WCAG 2.1 defines it
 * @param hex Colour in #rrggbb form
 * @returns Luminance between 0 and 1
 */
function luminance(hex : string) : number {
    const value = hex.replace("#", "");
    const channels = [ 0, 2, 4 ].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);

    const linear = channels.map((channel) => (channel <= 0.04045
        ? channel / 12.92
        : Math.pow((channel + 0.055) / 1.055, 2.4)));

    return 0.2126 * (linear[0] as number) + 0.7152 * (linear[1] as number) + 0.0722 * (linear[2] as number);
}

/**
 * Contrast ratio between two colours
 * @param first First colour
 * @param second Second colour
 * @returns Ratio between 1 and 21
 */
function contrast(first : string, second : string) : number {
    const [ lighter, darker ] = [ luminance(first), luminance(second) ].sort((a, b) => b - a);
    return ((lighter as number) + 0.05) / ((darker as number) + 0.05);
}

/**
 * Read the token values of one block of tokens.scss.
 *
 * The blocks are the themes: `:root` carries the light theme and `body.dark`
 * carries the dark one, so a token can be checked per theme.
 * @param source Content of tokens.scss
 * @param selector Selector opening the block
 * @returns Map of token name to value
 */
function readTokens(source : string, selector : string) : Record<string, string> {
    const start = source.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `tokens.scss has no ${selector} block`);

    const end = source.indexOf("\n}", start);
    const block = source.slice(start, end);
    const tokens : Record<string, string> = {};

    for (const line of block.split("\n")) {
        const match = /^\s*(--[a-z0-9-]+):\s*([^;]+);/.exec(line);

        if (match?.[1] && match[2]) {
            tokens[match[1]] = match[2].trim();
        }
    }

    return tokens;
}

/** Theme of the design system, with the tokens that carry colour */
interface Theme {
    name : string;
    tokens : Record<string, string>;
}

/**
 * Both themes as the stylesheet declares them.
 * The dark block only redefines colour, so it is layered over the light one -
 * exactly how the browser resolves it.
 * @returns Light and dark themes
 */
function readThemes() : Theme[] {
    const source = readFileSync(TOKENS_PATH, "utf8");
    const light = readTokens(source, ":root");
    const dark = { ...light,
        ...readTokens(source, "body.dark") };

    return [
        { name: "светлая",
            tokens: light },
        { name: "темная",
            tokens: dark },
    ];
}

/**
 * Every surface of the system, not only the two flat ones: muted text sits on the
 * sunken strip of the stability panel and on the raised row just as often
 */
const SURFACES = [
    "--surface-base",
    "--surface-panel",
    "--surface-sidebar",
    "--surface-raised",
    "--surface-sunken",
];

/** Text tokens, each checked against every surface it can land on */
const TEXT_TOKENS = [
    "--text-strong",
    // The faint token is the one that used to fail: it is still real text
    "--text-faint",
    "--text-muted",
    "--accent-text",
];

/**
 * State colours are text too - the word next to a counter, the stability verdict,
 * the Git change line - so they carry the text threshold, not the 3:1 of a fill
 */
const STATE_TOKENS = [
    "--state-running",
    "--state-attention",
    "--state-stopped",
    "--state-unknown",
    "--state-failed",
    "--state-changes",
    // Приглушенное состояние остается текстом работающей ссылки, поэтому порог тот же
    "--state-running-quiet",
    "--state-attention-quiet",
    "--state-stopped-quiet",
    "--state-unknown-quiet",
];

/** One threshold for both lists: a colour that carries words is read, not glanced at */
const NEED = 4.5;

test("текст любой темы читается на каждой поверхности", () => {
    for (const theme of readThemes()) {
        for (const token of TEXT_TOKENS) {
            const text = theme.tokens[token];
            assert.ok(text, `${theme.name}: нет токена ${token}`);

            for (const surfaceToken of SURFACES) {
                const surface = theme.tokens[surfaceToken] as string;
                assert.ok(surface, `${theme.name}: нет токена ${surfaceToken}`);

                const ratio = contrast(text as string, surface);
                assert.ok(
                    ratio >= NEED,
                    `${theme.name}: ${token} (${text}) на ${surfaceToken} (${surface}) дает ${ratio.toFixed(2)}, нужно ${NEED}`,
                );
            }
        }
    }
});

test("состояния читаются как текст на каждой поверхности", () => {
    for (const theme of readThemes()) {
        for (const token of STATE_TOKENS) {
            const colour = theme.tokens[token];
            assert.ok(colour, `${theme.name}: нет токена ${token}`);

            for (const surfaceToken of SURFACES) {
                const surface = theme.tokens[surfaceToken] as string;
                const ratio = contrast(colour as string, surface);
                assert.ok(
                    ratio >= NEED,
                    `${theme.name}: ${token} (${colour}) на ${surfaceToken} дает ${ratio.toFixed(2)}, нужно ${NEED}`,
                );
            }
        }
    }
});

test("надпись на акцентной кнопке и граница контрола проходят порог", () => {
    for (const theme of readThemes()) {
        const accent = theme.tokens["--accent"] as string;
        const ink = theme.tokens["--text-on-accent"] as string;
        const buttonRatio = contrast(ink, accent);
        assert.ok(
            buttonRatio >= 4.5,
            `${theme.name}: текст ${ink} на кнопке ${accent} дает ${buttonRatio.toFixed(2)}, нужно 4.5`,
        );

        // Граница - единственный признак "тихой" кнопки, поэтому 3:1 обязательны
        const border = theme.tokens["--line-control"] as string;
        const borderRatio = contrast(border, theme.tokens["--surface-base"] as string);
        assert.ok(
            borderRatio >= 3,
            `${theme.name}: граница контрола ${border} на фоне дает ${borderRatio.toFixed(2)}, нужно 3`,
        );
    }
});

test("состояние и акцент не делят один цвет", () => {
    for (const theme of readThemes()) {
        const accents = [ theme.tokens["--accent"], theme.tokens["--accent-text"] ];

        for (const token of STATE_TOKENS) {
            assert.equal(
                accents.includes(theme.tokens[token]),
                false,
                `${theme.name}: ${token} совпадает с акцентом, а синий обозначает только интерактив`,
            );
        }
    }
});

test("цели нажатия не меньше 32 пикселей, а на узком экране 44", () => {
    const source = readFileSync(TOKENS_PATH, "utf8");
    const light = readTokens(source, ":root");

    assert.equal(light["--control-height"], "32px");
    assert.equal(light["--control-height-touch"], "44px");

    // Узкий экран обязан поднимать цели: правило живет в самом файле токенов
    const narrow = source.slice(source.indexOf("@media (max-width: 900px)"));
    assert.match(narrow, /--control-height:\s*var\(--control-height-touch\)/);
});

test("Bootstrap и токены описывают один и тот же интерфейс", () => {
    const tokens = readTokens(readFileSync(TOKENS_PATH, "utf8"), "body.dark");
    const vars = readFileSync(VARS_PATH, "utf8");

    // Пока часть экранов рисуется старыми правилами, значения обязаны совпадать
    const pairs : [string, string][] = [
        [ "$dark-bg", "--surface-base" ],
        [ "$dark-bg2", "--surface-panel" ],
        [ "$dark-border-color", "--line-hair" ],
        [ "$dark-font-color", "--text-strong" ],
        [ "$dark-font-color3", "--text-faint" ],
    ];

    for (const [ scssVar, token ] of pairs) {
        const match = new RegExp(`\\${scssVar}:\\s*(#[0-9a-f]{6})`, "i").exec(vars);
        assert.ok(match?.[1], `vars.scss не задает ${scssVar}`);
        assert.equal(
            match[1].toLowerCase(),
            (tokens[token] as string).toLowerCase(),
            `${scssVar} и ${token} разошлись`,
        );
    }

    // Шрифт объявлен один и тот же, иначе body и #app наберутся разными
    assert.match(vars, /\$font-family-sans-serif:\s*"IBM Plex Sans"/);
    assert.match(vars, /\$font-family-monospace:\s*"IBM Plex Mono"/);
});

test("узкое начертание не используется: в нем нет русских букв", () => {
    const fonts = readFileSync(path.join(process.cwd(), "frontend/src/styles/fonts.scss"), "utf8");

    // IBM Plex Sans Condensed поставляется только с cyrillic-ext, то есть без
    // базовых русских букв, поэтому набирать им интерфейс нельзя
    assert.equal(fonts.includes("ibm-plex-sans-condensed"), false);

    // Кириллица подключена явно для каждого используемого веса
    for (const weight of [ 400, 500, 600 ]) {
        assert.ok(fonts.includes(`ibm-plex-sans/cyrillic-${weight}.css`), `нет кириллицы веса ${weight}`);
    }

    assert.ok(fonts.includes("ibm-plex-mono/cyrillic-400.css"));
});

/**
 * Файлы стилей проекта: SFC и таблицы стилей, кроме самих носителей значений.
 * @returns Пути относительно корня репозитория
 */
function listStyleFiles() : string[] {
    const roots = [ "frontend/src" ];
    const files : string[] = [];

    const walk = (dir : string) => {
        for (const entry of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
            const next = `${dir}/${entry.name}`;

            if (entry.isDirectory()) {
                walk(next);
            } else if (next.endsWith(".vue") || next.endsWith(".scss")) {
                files.push(next);
            }
        }
    };

    roots.forEach(walk);
    return files.sort();
}

/**
 * Часть файла, которая описывает вид: для SFC это блоки style, для scss весь файл
 * @param file Путь к файлу
 * @param source Содержимое
 * @returns Только оформление
 */
function styleBlocks(file : string, source : string) : string {
    if (!file.endsWith(".vue")) {
        return source;
    }

    return [ ...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g) ].map((match) => match[1] ?? "").join("\n");
}

/** Файлы, которым разрешено объявлять цвет: сами значения и мост к Bootstrap */
const COLOUR_OWNERS = [
    "frontend/src/styles/tokens.scss",
    "frontend/src/styles/vars.scss",
    "frontend/src/styles/main.scss",
];

test("компоненты не объявляют цвет сами, а берут его токеном", () => {
    const offenders : string[] = [];

    for (const file of listStyleFiles()) {
        if (COLOUR_OWNERS.includes(file)) {
            continue;
        }

        const styles = styleBlocks(file, readFileSync(path.join(process.cwd(), file), "utf8"));

        for (const [ index, line ] of styles.split("\n").entries()) {
            const isComment = line.trimStart().startsWith("//");

            // Литерал цвета в компоненте означает, что одна из тем получит чужой цвет
            if (!isComment && /#[0-9a-fA-F]{3,8}\b|(?<![-\w])rgba?\(/.test(line)) {
                offenders.push(`${file}:${index + 1} ${line.trim()}`);
            }
        }
    }

    assert.deepEqual(offenders, [], `цвет объявлен вне токенов:\n${offenders.join("\n")}`);
});

/**
 * Проверить, что блок под тему занят только подменой ассетов Bootstrap.
 *
 * Галочка селекта, ползунок переключателя и крестик закрытия нарисованы внутри
 * Bootstrap вшитым SVG или подобраны фильтром, поэтому цвет им нельзя передать
 * токеном. Все остальное под селектором темы - продублированный цвет.
 * @param lines Строки блока стилей
 * @param start Строка с селектором темы
 * @returns Правда, если внутри только переменные --bs-*
 */
function onlySwapsBootstrapAssets(lines : string[], start : number) : boolean {
    let depth = 0;

    for (let index = start; index < lines.length; index += 1) {
        const line = lines[index] as string;
        depth += (line.match(/\{/g) ?? []).length;
        depth -= (line.match(/\}/g) ?? []).length;

        const declaration = /^\s*([-a-z][^:]*):/.exec(line);

        if (declaration?.[1] && !declaration[1].trim().startsWith("--bs-")) {
            return false;
        }

        if (depth <= 0 && index > start) {
            return true;
        }
    }

    return false;
}

test("тема не дублируется правилами под темную", () => {
    const offenders : string[] = [];

    for (const file of listStyleFiles()) {
        if (file === "frontend/src/styles/tokens.scss") {
            continue;
        }

        const styles = styleBlocks(file, readFileSync(path.join(process.cwd(), file), "utf8"));

        const lines = styles.split("\n");

        for (const [ index, line ] of lines.entries()) {
            if (line.trimStart().startsWith("//")) {
                continue;
            }

            // Правило под тему объявляет цвет дважды и однажды разойдется с токеном.
            // Разрешено единственное исключение: блок, который только подменяет
            // переменные Bootstrap с вшитым SVG - такое значение токен прочитать не может.
            if (/(^|[\s,>])(body)?\.dark(\s|,|>|&|\{|\.)/.test(line) && !onlySwapsBootstrapAssets(lines, index)) {
                offenders.push(`${file}:${index + 1} ${line.trim()}`);
            }
        }
    }

    assert.deepEqual(offenders, [], `правило под тему вместо токена:\n${offenders.join("\n")}`);
});

/** Свойства, значение которых обязано приходить токеном шкалы */
const SCALE_PROPERTIES = [ "font-size", "line-height", "font-weight", "z-index" ];

/**
 * Найти в строке стиля значение, заданное мимо шкалы.
 * @param line Строка блока стилей
 * @returns Нарушения: свойство и его значение
 */
function scaleLiterals(line : string) : string[] {
    const found : string[] = [];

    for (const property of SCALE_PROPERTIES) {
        for (const match of line.matchAll(new RegExp(`${property}:\\s*([^;}]+)`, "g"))) {
            const value = (match[1] ?? "").trim();

            // Относительный кегль внутри строки текста (`code`, `small`)
            // намеренно следует за родителем и шкалой не задается
            if (value.startsWith("var(") || value === "inherit" || /^[0-9.]+%$/.test(value)) {
                continue;
            }

            found.push(`${property}: ${value}`);
        }
    }

    return found;
}

test("кегль, интерлиньяж, начертание и слой берутся шкалой, а не числом", () => {
    const offenders : string[] = [];

    for (const file of listStyleFiles()) {
        if (file === "frontend/src/styles/tokens.scss") {
            continue;
        }

        const lines = styleBlocks(file, readFileSync(path.join(process.cwd(), file), "utf8")).split("\n");

        for (const [ index, line ] of lines.entries()) {
            if (line.trimStart().startsWith("//")) {
                continue;
            }

            for (const literal of scaleLiterals(line)) {
                offenders.push(`${file}:${index + 1} ${literal}`);
            }
        }
    }

    assert.deepEqual(offenders, [], `значение шкалы задано мимо токена:\n${offenders.join("\n")}`);
});

test("шкала описана целиком: у каждого кегля есть интерлиньяж", () => {
    const light = readTokens(readFileSync(TOKENS_PATH, "utf8"), ":root");

    for (const step of [ "xs", "sm", "base", "md", "lg", "xl", "title-sm", "code" ]) {
        assert.ok(light[`--text-${step}`], `нет кегля --text-${step}`);
        assert.ok(light[`--line-${step}`], `у --text-${step} нет интерлиньяжа --line-${step}`);
    }

    // Роль без веса и без движения снова заставит компонент придумывать число
    for (const token of [ "--weight-regular", "--weight-medium", "--weight-strong",
        "--motion-fast", "--motion-base", "--motion-slow", "--motion-ease",
        "--field-height", "--icon-sm", "--icon-md", "--icon-lg", "--radius-card",
        "--layer-header", "--layer-modal", "--layer-toast" ]) {
        assert.ok(light[token], `нет токена ${token}`);
    }
});

test("запрет анимации гасится в самих токенах", () => {
    const source = readFileSync(TOKENS_PATH, "utf8");
    const reduced = source.slice(source.indexOf("@media (prefers-reduced-motion: reduce)"));

    assert.match(reduced, /--motion-base:\s*0ms/);
});
