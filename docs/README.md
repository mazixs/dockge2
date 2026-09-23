# Dockge2 documentation

## Running the panel

| Guide | What it covers |
| --- | --- |
| [Installation](installation.md) | Requirements, the verified installer, options, first sign-in, SSH keys and certificates, uninstalling |
| [Updating](updating.md) | Updates, rollback, interrupted updates, upgrading an installation older than 0.0.10 |
| [Configuration](configuration.md) | Environment variables, reverse proxy, HTTPS |
| [Authentication](authentication.md) | Accounts and roles, two-factor authentication, a lost password, sessions |
| [Stacks from Git](git-stacks.md) | Deploying from a repository, updating file by file, private repositories |
| [MCP access](mcp.md) | Access for AI clients: keys, scopes, limits and verified clients |
| [FAQ](faq.md) | Frequent questions |

## In depth

| Page | What it covers |
| --- | --- |
| [Verified self-updates](self-updates.md) | The release contract and its trust root, cutover and recovery, the legacy import |
| [Release notes](releases/) | What changed in each release |

## Working on the source

| Page | What it covers |
| --- | --- |
| [Development](development.md) | Running from source, the test suites, performance checks |
| [Contributing](../.github/CONTRIBUTING.md) | What kind of change is accepted and how to submit it |
| [Security policy](../.github/SECURITY.md) | How to report a vulnerability |
| [Design system](design-system.md) | Tokens and the current layout (in Russian) |
| [Translations](../frontend/src/lang/README.md) | Which languages, and how to translate |
| [AGENTS.md](../AGENTS.md) | The project guide: scope, architecture, rules about the user's files |

`plans/` and `design/` hold historical plans and audits, in Russian. They record what was decided and
why; the code is the current state. The running journal of decisions is
[the master plan](plans/2026-08-26-dockge2-master-plan.md).
