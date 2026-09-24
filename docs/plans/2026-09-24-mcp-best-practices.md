# MCP: best practices checklist and plan

Date: 2026-09-24. Scope: the `/mcp` endpoint, its settings page, its log and its documentation.
The backlog stays in the master plan; this file is the checklist the work was measured against.

## Sources

- MCP specification **2026-07-28** (the latest revision): Streamable HTTP, versioning, tools,
  authorization, security best practices.
- TypeScript SDK v2: `@modelcontextprotocol/server` 2.1.0, `@modelcontextprotocol/client` 2.1.0.
  v1 (`@modelcontextprotocol/sdk` 1.30.x) stops at protocol 2025-11-25.
- Supabase MCP (`supabase/mcp`, commit `4cc6660`): stateless serving, restrictions that live in
  the token rather than in the URL, write tools hidden from `tools/list`, generated per-client
  snippets, a security section describing the attack on your own data.
- Our own research on MCP tool design (`mcp-research/docs/research.md`): one action per tool, a
  description that says when to call it, errors the model can fix, annotations and a stable order,
  compact output.
- Client documentation for header configuration: Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI.

## Checklist

Protocol and transport

- [x] Serve 2026-07-28 through SDK v2 `createMcpHandler`. Keep 2025-11-25 clients working through
  the stateless legacy path of the same handler.
- [x] POST only. GET and DELETE get 405. No protocol sessions and no SSE resumption.
- [x] Check Host and Origin before parsing a body (DNS rebinding). A bad Origin gets 403.
- [x] The SDK validates `MCP-Protocol-Version`, `Mcp-Method` and the per-request `_meta` envelope.
- [x] Bound the request body and the response size. Refuse rather than truncate.
- [x] Return tools in a deterministic order, with server instructions describing the flow.
- [x] Use no deprecated features: roots, sampling, logging, the HTTP+SSE transport.

Authentication

- [x] The key is accepted only from `Authorization: Bearer`, never from a query string or cookie.
- [x] 401 with `WWW-Authenticate: Bearer` for a missing or invalid key. 403 for a host, origin or
  query-string problem. Missing rights are a tool error, the same generic sentence as a missing stack.
- [x] Publish no OAuth protected resource metadata while there is no authorization server. OAuth
  discovery paths answer 404 JSON instead of the SPA page.
- [x] Keys are individual, expiring, revocable, scoped to servers and stacks. Tools a key cannot
  call are not listed.
- [x] Never forward a received key upstream. The executing-server channel uses its own signed
  context.

Reachability and setup

- [x] Prefill the endpoint from the address the owner has open, not from a guessed base URL.
- [x] Warn before saving when the endpoint host differs from the page host.
- [x] Plain HTTP beyond loopback only after an explicit opt-in, with a visible warning.
- [x] Behind a trusted proxy (`DOCKGE_TRUST_PROXY`), compare `X-Forwarded-Host` and rate-limit by
  the client address, not the proxy address.
- [x] A status panel shows: on or off, the endpoint, encryption, active keys, the last connection
  and the last refusal with its reason.
- [x] Saving reports success. Failures name the reason: wrong password, invalid address, plain HTTP
  not allowed.
- [x] After a key is issued, show ready-made configs for common clients with the key in an
  environment variable, plus a `curl` check.

Tools

- [x] Descriptions: what the tool does, when to call it, what it returns and the next step.
- [x] Annotations carry `title` and accurate read-only, destructive, idempotent and open-world hints.
- [x] Invalid arguments get an actionable message naming the field. Access and existence stay one
  generic refusal, so a key learns nothing about stacks it cannot see.
- [x] Output is compact JSON. Untrusted data (logs, files, diffs) is named as such in the
  descriptions and the instructions.

Audit log

- [x] Record connections: `initialize` (2025), `server/discover` (2026) and `tools/list`, with the
  client name and version and the protocol revision.
- [x] Record refused attempts with a reason and the client address, aggregated per address and
  reason per minute, and capped separately so that refusals cannot push call history out.
- [x] Show the key name, client, stack, outcome or reason, and address in the interface.
- [x] Never record arguments, secrets or results.

Reserved names

- [x] Explain what a reservation is for (`git_clone` into a stack that does not exist yet).
- [x] List reservations with the keys that use them, and allow removing one. A duplicate name
  reports a clear error.

Documentation and tests

- [x] Rewrite `docs/mcp.md` in English: quick start, client configs, tools, rights, approval,
  security, troubleshooting by status code, the log, limits.
- [x] Unit tests with both a 2026-07-28 and a 2025-11-25 client, audit rows, refusals, opt-in HTTP
  and reservations. Update the Docker and browser suites.

Found during the work

- [x] Log owner approval of an operation, with the key, the action and the stack.
- [x] Mount the routes without touching the database: `mountMcp` opened it before it was connected
  and the panel failed to start. Covered by a unit test.

## Verification

`npm run check` (lint, TypeScript, Vue types, 591 unit tests, coverage floors), `npm run
build:frontend`, `test/docker/mcp-remote.test.ts` with real Docker, `test/e2e/mcp.spec.ts` in
Chromium, and `curl` against a running endpoint with both protocol revisions.

## Deliberately not done

- **OAuth 2.1.** Its only reason would be web clients that cannot send a header. DCR is deprecated in
  2026-07-28, and a self-hosted panel would have to run its own authorization server. Keys stay.
- **Elicitation instead of owner approval.** The client renders the form and can answer it itself.
  Approval in the panel with the owner password and replay protection is stronger.
- **Server Cards.** SEP-2127 is not part of 2026-07-28, and its path is not settled.
- **Wrapping untrusted output in random boundaries.** Supabase does it, and calls it cheap and not a
  defence. We name the data as untrusted and document the attack instead.
