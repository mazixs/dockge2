# AI access through MCP

MCP is turned on by the owner in Settings -> AI access / MCP. The endpoint is off by default. Every
AI client gets its own key with a responsible user, an expiry, a role and an explicit set of
server/stack pairs. A key is not a browser password and not Docker or Git credentials.

## Connecting

1. Sign in with a normal owner account. Disabled browser authentication does not substitute for a
   session when managing MCP.
2. Enter the exact external address `https://dockge.example/mcp`, enable MCP and confirm with the
   password. HTTP is allowed for loopback only. The reverse proxy has to pass through the original
   `Host` and it has to match the configured address. Foreign origins are rejected; a machine client
   with no `Origin` at all is accepted when its key is valid.
3. Press "Create key". The default is a viewer for 30 days; 1 to 90 days is allowed. Choose the
   responsible user and the specific stacks. The secret is shown once. The database stores only the
   SHA-256 of a random 32 byte secret together with a public identifier.
4. Pass the key only in `Authorization: Bearer <key>`. Never in a URL, in tool arguments or in a Git
   repository.

An example for Node.js with `@modelcontextprotocol/sdk@1.30.0` installed. The secret and the URL come
from the client process environment; do not put real values in this example:

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "my-dockge-agent", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(
    new URL(process.env.DOCKGE_MCP_URL),
    { requestInit: { headers: { Authorization: `Bearer ${process.env.DOCKGE_MCP_KEY}` } } }
);
await client.connect(transport);
const result = await client.callTool({ name: "stacks_list", arguments: { server_id: "local" } });
console.log(result);
await client.close();
```

What has been verified is exactly this combination: TypeScript SDK 1.30.0, Bearer and Streamable
HTTP, against real Dockge processes. That SDK negotiates protocol **2025-11-25**. This is not a claim
of support for protocol 2026-07-28 or for OAuth 2.1. OAuth and discovery, stdio, and any particular
desktop client are neither implemented nor verified. An HTTP GET is answered with 405; no SSE stream
and no protocol sessions are created. Sources: the
[Streamable HTTP specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and the [official SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Rights

| Tool or action | Extra operator right |
| --- | --- |
| `servers_list`, `stacks_list`, `containers_list`, `container_status`, `stability_get` | available to a viewer within its scope |
| `container_logs` | `logs:read` |
| `container_start`, `container_stop`, `container_restart` | `containers:control` |
| `stack_start`, `stack_stop`, `stack_restart` | `stacks:control` |
| `stack_files_read` | `files:read` |
| `stack_files_write` | `files:write` |
| `git_preview`, `git_preview_result` | `git:read` |
| `git_apply` | `git:apply`, plus `deploy` to deploy |
| `stack_deploy`, `stack_images_update`, `git_clone` | `deploy` |

The changing actions in that table run through `operation_prepare` and `operation_apply`. Calling a
tool that does not exist does not bypass the check. A viewer never receives files, env, logs, raw
inspect output, arbitrary commands, keys, or another subject's operations. Giving a user a higher
role does not raise the ceiling of an existing key. A demotion, a suspension, a revocation, an expiry
and a narrowed scope are all re-checked before execution and before the result is handed back.

An operator that can write compose or deploy is a trusted user of the Docker host. A stack scope is
not a sandbox: a compose file can ask for mounts and privileges. Shell and exec, arbitrary Docker or
Git commands, deleting stacks or volumes, prune, and user administration are not offered at all.

A managed stack is tied to a directory instance through separate metadata. A directory recreated
under the same name gets a new identifier, and an old key does not inherit access to it. For
`git_clone` the owner first reserves the name in the MCP settings and explicitly puts its identifier
in the key's scope. Reserving does not create the directory, and cloning never overwrites an existing
path.

## Prepare, confirm, result

```json
{
  "name": "operation_prepare",
  "arguments": {
    "action": "stack_restart",
    "request_id": "maintenance-001",
    "parameters": { "server_id": "local", "stack_id": "<UUID from stacks_list>" }
  }
}
```

The response carries `operation_id`, `parameters_hash`, the subject, the action and a deadline.
`operation_apply` then accepts only that ID and that hash. For a remote server, also pass `server_id`
at the top level of `operation_apply` and `operation_status`.

An operator key can either perform its allowed actions automatically or require the owner to confirm.
In the second mode, open the pending operation **on the executing server**, enter the password again,
read the actual changes and confirm. A comparison can contain sensitive compose data: it is shown
only to the owner after the password, is never written to the log, and is never returned to a viewer.
A hidden or binary change cannot be applied by a key in confirmation mode, because no meaningful
comparison can be shown. To clone with confirmation, use `deploy:false` first and then a separate
`stack_deploy` after reading the actual compose.

Prepared parameters and comparisons live 10 minutes in memory. After a restart a preparation or a
preview no longer applies. An idempotent `request_id` is bound in the database to the key and the
parameter hash: a repeat does not start a second restart or deploy, and different parameters are
rejected. After a dropped connection, check `operation_status`. An operation that was running during
a crash may have an unknown outcome; nothing is retried automatically.

A Git check performs a fetch, so it also goes through prepare/apply. A finished `git_preview` returns
a `preview_id`, and `git_preview_result` reads that key's comparison. `git_apply` takes the full file
selection and the exact text of a manual result. The underlying Git workflow re-checks the tree, the
selected files, the compose file and the index. Saving and deploying are reported separately (`saved`,
`deployed`). If the deployment fails the saved files stay saved; container data is not rolled back.

Reading a file returns the SHA-256 of its original bytes. `stack_files_write` requires that hash,
stores the exact UTF-8 text with its comments and formatting, does not rebuild the YAML and does not
touch neighbouring env files. That is a save without a start; the start is validated by a separate
deployment. A file changed after the preparation is rejected.

## Executing servers

This is a separate signed Ed25519 channel, not the existing privileged browser session of an agent.
The external Bearer key is never forwarded. Each side needs a file named by
`DOCKGE_MCP_DELEGATION_CONFIG`, owned by the process user, with permissions `0600`:

```json
{
  "serverId": "control",
  "privateKey": "<PEM Ed25519 private key of this server>",
  "peers": [
    {
      "id": "worker",
      "name": "Worker",
      "url": "https://worker.example/",
      "publicKey": "<PEM Ed25519 public key of worker>",
      "allowedStackIds": ["<explicit stack UUID>"],
      "actions": ["stacks_list", "containers_list", "container_status", "stability_get"],
      "role": "viewer",
      "ownerId": "<active responsible local account ID>"
    }
  ]
}
```

Under Compose, set `DOCKGE_MCP_DELEGATION_CONFIG=/app/data/mcp-delegation.json` in the env file and
put the configuration in the mounted data directory. Both compose configurations pass the variable
through. A separate local database is selected with `DOCKGE_LOCAL_DATA_DIR`, and `.env.local` is
loaded explicitly by `local.sh`.

On the other side, configure the reverse peer with the first side's public key. Private keys are
created and distributed by host administration; the interface never exports them. `actions` here
holds tool and action names, not the permission strings of a key. For an operator, also list
`operation_prepare`, `operation_apply`, `operation_status` and the specific action, for example
`stack_restart`. Combining `git_apply` with a deployment also needs `stack_deploy` on the peer. The
sent subject's rights are intersected with the current local role of the account responsible for the
connection, with the action list and with the server/stack pair; an administrative account on the
connection does not promote a viewer.

The signature binds the sender, the receiver, the subject, the parameters, the ID and a short
deadline. A replayed message is rejected. The executing server asks the sender for the current state
of the key before and after the operation and at checkpoints before any side effect. Revoking trust or
disabling either side stops further execution. A separate identifier namespace prevents another
peer's key from standing in for a local operation.

## Limits and operation

- At most 100 stacks and 20 servers per key, no wildcards. Managed stacks only; containers outside
  them are never modified.
- Per source address over HTTP: 60 requests a minute and at most 4 at once, with up to 1000 addresses
  in the limit table. The peer channel has its own limits on concurrency, size and retries.
- An MCP request body is up to 2 MB and a response up to 256 KiB. A file or a diff that does not fit
  makes the request fail rather than being silently truncated. A file is up to 1 MB, Git up to 1000
  files and 20 MB by the underlying workflow. Logs: up to 200 lines, 24 hours and 64 KiB.
- Docker commands have time and output limits. During a long operation a revocation stops the next
  checkpoints, but what already happened is not rolled back automatically.
- Deployment does not support compose inputs that cannot be checked - external or computed file
  inputs, `build`, `develop`, `provider`. Those are rejected until a preparation can be bound
  reliably to every input. An ordinary stop, restart, save or Git check needs no build validation.
- The access log keeps metadata for up to 30 days and 10000 records. It holds no files, env, tokens,
  log responses or stderr. Owner review is kept in memory only. Narrowing access raises the policy
  version and invalidates older preparations. To widen access, create a new key and revoke the old
  one separately.
- Reading status uses confirmed observation history. Between a new stack identifier appearing and the
  next observation there may be no data. Unconfirmed intervals never turn into 100% availability.

The checks live in `test/backend/mcp-*.test.ts`, `test/docker/mcp-remote.test.ts` and the browser
scenario for key management. What is verified: the real SDK, two isolated processes, remote scope
limiting, revocation, confirmation, a repeat that does not cause a second restart, and a real Git
fetch and apply with exact bytes. Individual external clients and OAuth are not in that list.
