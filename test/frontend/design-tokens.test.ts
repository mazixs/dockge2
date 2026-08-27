import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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
        { name: "тёмная",
            tokens: dark },
    ];
}

/** Text tokens and the surface they are allowed to sit on */
const TEXT_PAIRS = [
    { text: "--text-strong",
        on: "--surface-base",
        need: 4.5 },
    { text: "--text-strong",
        on: "--surface-panel",
        need: 4.5 },
    { text: "--text-muted",
        on: "--surface-base",
        need: 4.5 },
    { text: "--text-muted",
        on: "--surface-panel",
        need: 4.5 },
    // The faint token is the one that used to fail: it is still real text
    { text: "--text-faint",
        on: "--surface-base",
        need: 4.5 },
    { text: "--text-faint",
        on: "--surface-panel",
        need: 4.5 },
    { text: "--accent-text",
        on: "--surface-panel",
        need: 4.5 },
];

/** State colours never carry text on their own, so they follow the 3:1 rule */
const STATE_TOKENS = [
    "--state-running",
    "--state-attention",
    "--state-stopped",
    "--state-unknown",
    "--state-failed",
];

test("текст любой темы читается на своей поверхности", () => {
    for (const theme of readThemes()) {
        for (const pair of TEXT_PAIRS) {
            const text = theme.tokens[pair.text];
            const surface = theme.tokens[pair.on];
            assert.ok(text && surface, `${theme.name}: нет токена ${pair.text} или ${pair.on}`);

            const ratio = contrast(text, surface);
            assert.ok(
                ratio >= pair.need,
                `${theme.name}: ${pair.text} (${text}) на ${pair.on} (${surface}) даёт ${ratio.toFixed(2)}, нужно ${pair.need}`,
            );
        }
    }
});

test("состояния различимы на обеих поверхностях", () => {
    for (const theme of readThemes()) {
        for (const token of STATE_TOKENS) {
            const colour = theme.tokens[token];
            assert.ok(colour, `${theme.name}: нет токена ${token}`);

            for (const surfaceToken of [ "--surface-base", "--surface-panel" ]) {
                const surface = theme.tokens[surfaceToken] as string;
                const ratio = contrast(colour, surface);
                assert.ok(
                    ratio >= 3,
                    `${theme.name}: ${token} (${colour}) на ${surfaceToken} даёт ${ratio.toFixed(2)}, нужно 3`,
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
            `${theme.name}: текст ${ink} на кнопке ${accent} даёт ${buttonRatio.toFixed(2)}, нужно 4.5`,
        );

        // Граница - единственный признак «тихой» кнопки, поэтому 3:1 обязательны
        const border = theme.tokens["--line-control"] as string;
        const borderRatio = contrast(border, theme.tokens["--surface-base"] as string);
        assert.ok(
            borderRatio >= 3,
            `${theme.name}: граница контрола ${border} на фоне даёт ${borderRatio.toFixed(2)}, нужно 3`,
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

    // Узкий экран обязан поднимать цели: правило живёт в самом файле токенов
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
        assert.ok(match?.[1], `vars.scss не задаёт ${scssVar}`);
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

test("узкое начертание не используется: в нём нет русских букв", () => {
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
