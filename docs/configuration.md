# Configuration

Most settings live in the web interface, under Settings. Environment variables are for startup only.
A release installation reads them from `<installation>/.env`; a change takes effect after
[running the updater](updating.md#changing-the-configuration). The annotated list is
[`.env.example`](../.env.example).

## Environment variables

### The panel

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCKGE_PORT` | `5001` | Port of the web interface, the same on the host and in the container |
| `DOCKGE_HOSTNAME` | all interfaces | Address the server listens on inside the container |
| `DOCKGE_DATA_DIR` | `<installation>/data` | Host path of the panel data; in the container it is always `/app/data`. Set on installation |
| `DOCKGE_STACKS_DIR` | `/opt/stacks` | Absolute path of the stacks, mounted at the same path. Set on installation |
| `PUID`, `PGID` | root | Owner of the files the panel creates in stacks; set both or neither |
| `DOCKGE_ENABLE_CONSOLE` | `false` | `true` turns the web console on for good: a shell in the panel container. Without it an owner can turn the console on and off in Settings, Security, confirming with the password. Either way only owners open it unless an owner lets operators in on the same page. The container holds the Docker socket, so treat the console as root on the host |
| `DOCKGE_IMAGE` | `ghcr.io/mazixs/dockge2:latest` | Image for a plain `docker compose` run. The updater keeps its own record, change it with [`--image`](updating.md#channel-and-mirror) |

### Access and HTTPS

| Variable | Meaning |
| --- | --- |
| `DOCKGE_PUBLIC_URL` | Public HTTP(S) origin without a path, for example `https://dockge.example.com`. HTTPS switches Secure cookies on |
| `DOCKGE_TRUST_PROXY` | `true` to believe `X-Forwarded-*` headers. Only behind a proxy that overwrites them |
| `DOCKGE_SECURE_COOKIES` | `true` to mark the session cookie `Secure` when TLS ends at the proxy |
| `DOCKGE_TRUSTED_ORIGINS` | Extra browser origins, comma separated, for a UI served from another address |
| `DOCKGE_BOOTSTRAP_TOKEN` | One-use setup code of at least 32 characters. Empty: it is generated into `bootstrap-token` in the data directory |
| `DOCKGE_AUTH_SECRET` | Signs session cookies. Empty: generated on first start and kept in the database. Set it only to share one secret between instances |
| `DOCKGE_SSL_KEY`, `DOCKGE_SSL_CERT`, `DOCKGE_SSL_KEY_PASSPHRASE` | HTTPS without a proxy: paths inside the container to mounted files |
| `DOCKGE_MCP_DELEGATION_CONFIG` | Signed cross-server MCP channel, a `0600` file in the data directory. See [MCP](mcp.md) |

### Diagnostics

| Variable | Meaning |
| --- | --- |
| `DOCKGE_HIDE_LOG` | Log categories to hide, comma separated, for example `debug_monitor,info_monitor` |
| `DOCKGE_WS_ORIGIN_CHECK` | `bypass` switches the WebSocket origin check off. A last resort, never on a public instance |

## Behind a reverse proxy

The panel accepts requests whose origin matches the address the browser asked for, so a LAN
address, a container name and a domain all work without configuration. Behind a TLS proxy on a
public domain, set:

```dotenv
DOCKGE_PUBLIC_URL=https://dockge.example.com
DOCKGE_TRUST_PROXY=true
DOCKGE_SECURE_COOKIES=true
```

Everything the panel shows, from statuses to logs and terminals, travels over one WebSocket, and
its handshake is checked against the same origins. A proxy that rewrites `Host` to an internal name
has to pass `X-Forwarded-Host` and `X-Forwarded-Proto` together with `DOCKGE_TRUST_PROXY=true`, or
the public address has to be named in `DOCKGE_PUBLIC_URL`. Without one of the two the page loads and
then stays on "connecting". A working nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:5001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $http_host;   # with the port, when the address has one
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

Close direct access to the panel port in your firewall: with `DOCKGE_TRUST_PROXY=true` anyone who
reaches the port could write those headers. The login rate limit, origin and CSRF checks stay on.
More in [authentication](authentication.md#https-and-a-reverse-proxy).

## HTTPS without a proxy

Mount the key and the certificate into the container on
[installation](installation.md#ssh-keys-registry-logins-and-certificates), for example at
`/app/certs`, and name them:

```dotenv
DOCKGE_SSL_KEY=/app/certs/key.pem
DOCKGE_SSL_CERT=/app/certs/cert.pem
```

## Private registries and repositories

Images from a private registry need a `docker login` inside the panel container, and private Git
repositories need an SSH key. Both are mounts, decided on
[installation](installation.md#ssh-keys-registry-logins-and-certificates). The Git side is described
in [stacks from Git](git-stacks.md#private-repositories).
