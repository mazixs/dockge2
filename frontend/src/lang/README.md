# Translations

How to translate Dockge2 into your language. There is no external translation platform:
the language files live in this repository and are edited directly.

## Rules

- `en.json` is the source of truth. Every new string goes there first, with the key in `camelCase`.
- `ru.json` is kept complete: a key that exists in `en.json` exists there too.
- No HTML inside a string. Markup goes into the template through `<i18n-t>`, so that a translator
  never has to copy tags and never can break the page with them.
- A string says what happens, not how it looks: `stackStopped`, not `redLabel`.

## How to translate an existing language

1. Open `frontend/src/lang/<code>.json`.
2. Translate the values, keep the keys exactly as they are in `en.json`.
3. Run `npm run check` and open the UI in that language to see the strings in place: a translation
   that is correct in isolation can still overflow a button.

## How to add a new language

1. Copy `en.json` to `frontend/src/lang/<code>.json`, where `<code>` is the
   [BCP 47](https://www.w3.org/International/articles/language-tags/) tag, for example `de` or `zh-TW`.
2. Translate the values.
3. Add the language at the end of `languageList` in `frontend/src/i18n.ts`, in the format
   `"zh-TW": "繁體中文 (台灣)"` - the name is written in that language itself, not in English.
4. Open a pull request. Missing keys fall back to English, so an incomplete language still works,
   but say in the pull request what is not translated yet.
