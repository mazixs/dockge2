## Can I create a pull request for Dockge2?

Yes or no, it depends on what you try to do. To avoid wasting your time, **open a discussion first**,
especially for a large pull request or when you do not know whether it fits the project.

Here are some references:

### Usually accepted

- Bug fix
- Security fix
- Adding new language files (see [these instructions](frontend/src/lang/README.md))
- Adding new language keys: `$t("...")`

### Discussion required

- Large pull requests
- New features

### Won't be merged

- Do not pass the automated checks (`npm run check`)
- Any breaking changes without a migration
- Duplicated pull requests
- UI/UX that does not follow [the design system](docs/design-system.md)
- Modifications or deletions of existing logic without a valid reason
- Adding functions that are completely out of scope
- Converting existing code into other programming languages
- Unnecessarily large code changes that are hard to review

The above cases may not cover all possible situations.

Please do not rush or ask for an ETA: a pull request has to be understood, checked for breaking changes
and matched against the direction of the project, which is written down in
[the master plan](docs/plans/2026-08-26-dockge2-master-plan.md).

## Project Styles

I personally do not like something that requires so many configurations before you can finally start the app.

- Settings should be configurable in the frontend. Environment variables are discouraged, unless it is related to startup such as `DOCKGE_STACKS_DIR`
- Easy to use
- The web UI styling should be consistent and nice
- Minimize native build dependencies; SQLite uses `better-sqlite3`

## Coding Styles

- 4 spaces indentation
- Follow `.editorconfig`
- Follow ESLint
- Methods and functions should be documented with JSDoc

## Name Conventions

- Javascript/Typescript: camelCaseType
- SQLite: snake_case (Underscore)
- CSS/SCSS: kebab-case (Dash)

## Tools

- [`Node.js`](https://nodejs.org/) 22.23.2 LTS or 24.19.0 LTS (24.19.0 is recommended)
- [`git`](https://git-scm.com/)
- IDE that supports [`ESLint`](https://eslint.org/) and EditorConfig (I am using [`IntelliJ IDEA`](https://www.jetbrains.com/idea/))
- A SQLite GUI tool (f.ex. [`SQLite Expert Personal`](https://www.sqliteexpert.com/download.html) or [`DBeaver Community`](https://dbeaver.io/download/))

## Install Dependencies for Development

```bash
npm install
```

## Dev Server

```
npm run dev:frontend
npm run dev:backend
```

## Backend Dev Server

It binds to `0.0.0.0:5001` by default.

It is mainly a socket.io app + express.js.

## Frontend Dev Server

It binds to `0.0.0.0:5000` by default. The frontend dev server is used for development only.

For production, it is not used. It will be compiled to `frontend-dist` directory instead.

You can use Vue.js devtools Chrome extension for debugging.

### Build the frontend

```bash
npm run build:frontend
```

## Tests

```bash
npm run check                 # lint + TypeScript + unit tests with coverage
npm run test:unit             # unit tests only
npm run test:docker-integration   # opt-in, needs a working Docker Compose
```

`npm run test` enforces the c8 coverage thresholds. The Docker integration test is skipped unless
`DOCKGE_DOCKER_INTEGRATION=1` is set, and CI runs it in a dedicated Linux job. Build the frontend
first: one of its tests starts a whole panel with `NODE_ENV=production`, and in that mode the backend
refuses to start without `frontend-dist/index.html`.

```bash
npx playwright install chromium   # once
npm run test:e2e                  # real Chromium, real clipboard, real Docker
```

The end to end tests start their own backend and frontend, seed a temporary data directory and run a
container from `test/e2e/seed.ts`. They deliberately use the real clipboard, the real xterm and a real
container: a stub would hide exactly the bugs they are there to catch.

```bash
npm run test:visual               # compare the interface with the approved baseline
npm run test:visual:approve       # re-approve it, only when the change of look is intended
```

The visual run has no Docker and no backend: it renders the production components against the fixed
scene in `test/visual/scene.ts`, so the same revision always gives the same frame. The baselines are
committed under `test/visual/baseline/`. A difference fails the run and is reviewed, one by one -
re-approving is a decision, not a step of the run.

## Database Migration

TODO

## Dependencies

Both frontend and backend share the same package.json. However, the frontend dependencies are eventually not used in the production environment, because it is usually also baked into dist files. So:

- Frontend dependencies = "devDependencies"
    - Examples: vue, chart.js
- Backend dependencies = "dependencies"
    - Examples: socket.io, better-sqlite3
- Development dependencies = "devDependencies"
    - Examples: eslint, sass

### Update Dependencies

Should only be done by the maintainer.

```bash
npm update
````

It should update the patch release version only.

Patch release = the third digit ([Semantic Versioning](https://semver.org/))

If for security / bug / other reasons, a library must be updated, breaking changes need to be checked by the person proposing the change.

## Translations

Please add **all** the strings which are translatable to `src/lang/en.json` (If translation keys are omitted, they can not be translated).

`en.json` is the source of truth and `ru.json` is kept complete. Other languages are translated
directly in this repository, there is no external translation platform.

See [the translation guide](frontend/src/lang/README.md) for how the language files are organised.

## Spelling & Grammar

Feel free to correct the grammar in the documentation or code.

## Origin

Dockge2 is a fork of [Dockge](https://github.com/louislam/dockge) by Louis Lam, MIT licensed.
Fixes made here are not sent upstream automatically, and upstream releases are not merged
automatically: the two projects have diverged in product decisions.
