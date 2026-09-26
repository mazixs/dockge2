# Translations

How to translate Dockge2 into your language. There is no external translation platform:
the language files live in this repository and are edited directly.

## Which languages

Dockge2 targets the most widely spoken languages rather than every language a contributor
offers. A language nobody keeps up to date is worse than a missing one, because the interface
looks translated and is not. Upstream Dockge carried thirty catalogues that had stopped at
one sixth of the strings; they were removed rather than shipped.

| Code | Language | State |
|---|---|---|
| `en` | English | source of truth, complete |
| `ru` | Русский | complete |
| `zh-CN` | 简体中文 | partial |
| `es` | Español | partial |
| `ar` | العربية | partial, right to left |
| `fr` | Français | partial |
| `pt` | Português | partial |
| `id` | Bahasa Indonesia | partial |
| `ur` | اردو | partial, right to left |
| `de` | Deutsch | partial |
| `ja` | 日本語 | partial |

Wanted and not started: Hindi (`hi`) and Bengali (`bn`). Both are among the most spoken
languages in the world and neither has a catalogue yet. They are deliberately absent from
`languageList` until one exists: an entry without a file breaks the switcher.

"Partial" means the catalogue came from upstream Dockge and covers roughly one sixth of the
current strings. Everything else falls back to English, so the interface works, but finishing
one of these is the most useful translation work there is.

## Rules

- `en.json` is the source of truth. Every new string goes there first, with the key in `camelCase`.
- `ru.json` is kept complete: a key that exists in `en.json` exists there too.
- No HTML inside a string. Markup goes into the template through `<i18n-t>`, so that a translator
  never has to copy tags and never can break the page with them.
- A string says what happens, not how it looks: `stackStopped`, not `redLabel`.
- A message is translated whole. Never build a sentence out of separate label keys: word order and
  grammar differ between languages.
- An error names the object, the confirmed cause and what to do next.
- The product speaks in a neutral voice, without "I" or "we".
- When a translation reads wrong because the English is wrong, fix `en.json` first.
- A key that is not in `en.json` is not translated anywhere. `test/frontend/i18n-catalogue.test.ts`
  fails on one, and on a language listed without a file or a file nobody can select.

## How to translate an existing language

1. Open `frontend/src/lang/<code>.json`.
2. Translate the values, keep the keys exactly as they are in `en.json`.
3. Run `npm run check` and open the UI in that language to see the strings in place: a translation
   that is correct in isolation can still overflow a button.

## How to add a new language

1. Copy `en.json` to `frontend/src/lang/<code>.json`, where `<code>` is the
   [BCP 47](https://www.w3.org/International/articles/language-tags/) tag, for example `hi` or `bn`.
2. Translate the values, and set `languageName` to the name of the language written in itself.
3. Add the language to `languageList` in `frontend/src/i18n.ts`, in the same form.
4. A language written right to left also goes into `rtlLangs` in the same file, which is what
   sets the page direction.
5. Open a pull request. Missing keys fall back to English, so an incomplete language still works,
   but say in the pull request what is not translated yet.
