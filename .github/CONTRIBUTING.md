# Contributing

## Can I create a pull request for Dockge2?

Yes or no, it depends on what you try to do. To avoid wasting your time, **open a discussion first**,
especially for a large pull request or when you do not know whether it fits the project.

Here are some references:

### Usually accepted

- Bug fix
- Security fix
- Adding new language files (see [these instructions](../frontend/src/lang/README.md))
- Adding new language keys: `$t("...")`

### Discussion required

- Large pull requests
- New features

### Won't be merged

- Do not pass the automated checks (`npm run check`)
- Any breaking changes without a migration
- Duplicated pull requests
- UI/UX that does not follow [the design system](../docs/design-system.md)
- Modifications or deletions of existing logic without a valid reason
- Adding functions that are completely out of scope
- Converting existing code into other programming languages
- Unnecessarily large code changes that are hard to review

The above cases may not cover all possible situations.

Please do not rush or ask for an ETA: a pull request has to be understood, checked for breaking changes
and matched against the direction of the project, which is written down in
[the master plan](../docs/plans/2026-08-26-dockge2-master-plan.md). The scope, architecture and rules
about the user's files are in [AGENTS.md](../AGENTS.md).

## Development

Running the panel from source, the test suites and the performance probe are described in
[development](../docs/development.md).

## Project styles

The app should start without configuring anything first.

- Settings should be configurable in the frontend. Environment variables are discouraged, unless it is related to startup such as `DOCKGE_STACKS_DIR`
- Easy to use
- The web UI styling should be consistent and nice
- Minimize native build dependencies; SQLite uses `better-sqlite3`

## Coding styles

- 4 spaces indentation
- Follow `.editorconfig`
- Follow ESLint
- Methods and functions should be documented with JSDoc

## Name conventions

- JavaScript/TypeScript: camelCase
- SQLite: snake_case (underscore)
- CSS/SCSS: kebab-case (dash)

## Dependencies

Both frontend and backend share the same package.json. However, the frontend dependencies are eventually not used in the production environment, because it is usually also baked into dist files. So:

- Frontend dependencies = "devDependencies"
    - Examples: vue, chart.js
- Backend dependencies = "dependencies"
    - Examples: socket.io, better-sqlite3
- Development dependencies = "devDependencies"
    - Examples: eslint, sass

### Update dependencies

Should only be done by the maintainer.

```bash
npm update
```

It should update the patch release version only.

Patch release = the third digit ([Semantic Versioning](https://semver.org/))

If for security / bug / other reasons, a library must be updated, breaking changes need to be checked by the person proposing the change.

TypeScript stays below 7 for now: `vue-tsc` does not run with it.

A pull request ported from upstream Dockge must not bring back the libraries this fork replaced:
`redbean-node` and `@louislam/sqlite3` (Knex and `better-sqlite3`), `jsonwebtoken`, `bcryptjs` and
`jwt-decode` (Better Auth), `promisify-child-process` (`backend/child-process.ts`), `command-exists`
(`backend/terminal.ts`), `thememirror` (`@codemirror/theme-one-dark`), `vue-toastification`
(`vue3-toastify`), `vite-plugin-compression` (`vite-plugin-compression2`) and `timezones-list`.

## Translations

Please add **all** the strings which are translatable to `frontend/src/lang/en.json` (If translation keys are omitted, they can not be translated).

`en.json` is the source of truth and `ru.json` is kept complete. Other languages are translated
directly in this repository, there is no external translation platform.

See [the translation guide](../frontend/src/lang/README.md) for how the language files are organised.

## Spelling & grammar

Feel free to correct the grammar in the documentation or code.

## Origin

Dockge2 is a fork of [Dockge](https://github.com/louislam/dockge) by Louis Lam, MIT licensed.
Fixes made here are not sent upstream automatically, and upstream releases are not merged
automatically: the two projects have diverged in product decisions.
