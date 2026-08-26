# Repository Guidelines

## Project Structure & Module Organization

Dockge is a TypeScript/Vue application with a shared Node.js package setup.

- `backend/` contains the Express, Socket.IO, database, migration, and agent code.
- `frontend/src/` contains Vue pages, components, styles, and localization files; static assets are in `frontend/public/`.
- `common/` holds utilities and types shared by the backend and frontend.
- `extra/` contains maintenance, release, health-check, and example Compose scripts.
- `docker/`, `compose.yaml`, and `.github/workflows/` define container images and CI.

## Build, Test, and Development Commands

Use Node.js `>=22.14.0`, then install dependencies with `npm install`.

- `npm run dev` starts the frontend and backend development servers together (ports 5000 and 5001).
- `npm run dev:frontend` or `npm run dev:backend` starts one side independently.
- `npm run lint` checks TypeScript and Vue files with ESLint; `npm run fmt` applies ESLint fixes.
- `npm run check-ts` runs strict TypeScript checking for `backend/` and `common/`.
- `npm run build:frontend` creates the production bundle in `frontend-dist/`.

There is currently no dedicated `npm test` script or coverage threshold. CI runs linting, type checking, and the frontend build.

## Coding Style & Naming Conventions

Follow `.editorconfig`: four spaces, LF line endings, UTF-8, and a final newline. Use double quotes, semicolons, and JSDoc for public or non-obvious methods. Follow ESLint, including Vue template indentation. Use `camelCase` for JavaScript/TypeScript identifiers, `snake_case` for SQLite names, `kebab-case` for CSS/SCSS, and two-space indentation for YAML.

## Testing Guidelines

For each change, run `npm run lint`, `npm run check-ts`, and `npm run build:frontend`. Manually exercise affected UI and backend flows with the development servers. If a change affects Docker or release behavior, also run the relevant script under `extra/`, such as `extra/test-docker.ts`, and record the result in the PR.

## Commit & Pull Request Guidelines

Use a short, imperative commit subject; the history commonly uses concise fixes/features and optional issue references, for example `feat: improve agent naming (#414)`. Keep commits focused. For a PR, read `CONTRIBUTING.md`, discuss large changes or new features first, link the issue, describe the change and validation performed, and include screenshots for UI changes. Complete the PR template and ensure CI passes.

## Security & Configuration Tips

Do not commit credentials or local stack data. Keep stack paths and startup settings in the documented configuration (for example `DOCKGE_STACKS_DIR`). Report vulnerabilities through the GitHub Security Advisory flow described in `SECURITY.md`, not the public issue tracker.
