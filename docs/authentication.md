# Access to Dockge2

Dockge2 uses better-auth for passwords, sessions and two factor authentication. Passwords are
hashed; the session lives in a cookie with `HttpOnly` and `SameSite=Lax`. Public signup is disabled
on the server, including on the first start.

## The first owner

Starting with no accounts creates a `bootstrap-token` file in `DOCKGE_DATA_DIR` with permissions
`0600`. Read it on the server and enter it in the setup form together with a username, an email and
a password. With a release installation the container is `dockge2-dockge-1`:

```sh
sudo docker exec dockge2-dockge-1 cat /app/data/bootstrap-token
```

For another setup, substitute your own container name, or read the file in the data directory on
the host. Do not put the code in a chat, an open log or a repository. The alternative is to pass
`DOCKGE_BOOTSTRAP_TOKEN`, at least 32 characters, through whatever protected mechanism configures
your environment.

Once the owner exists the file is deleted and that route refuses to create another. A code from the
environment also stops being accepted after setup; remove it from the environment at the next
maintenance window. The first owner and their password are created in a single SQLite transaction
with one initial-setup record, so concurrent requests cannot produce two first owners.

On an upgrade the previous account becomes the owner. Its identifier, password, two factor settings
and existing sessions are preserved, and email login keeps working. New accounts also get a
username: 3 to 30 Latin letters, digits, dots or underscores. A password is 10 to 128 characters.

## Accounts

The owner opens Settings -> Users and creates accounts. Nothing is emailed: how the credentials reach
the person is the owner's decision.

| Role | What it can do |
| --- | --- |
| Owner (`admin`) | Users, agents, settings, stacks and Docker |
| Operator (`operator`) | Stacks and Docker, including compose, environment, secrets, logs and the terminal |
| Viewer (`viewer`) | Statuses, the list of services, availability and stability. No compose or env contents, no secrets, no logs, no terminal |

An operator controls Docker and the terminal, which is host-level authority. It is trusted access:
the operator role is not a security boundary against the owner. New accounts default to viewer.

Resetting a password revokes every current session of that user and keeps their two factor setup.
Suspending an account blocks new logins. Changing a role or deleting an account also ends that
account's sessions, agent connections and terminal streams. The last active owner cannot be deleted,
suspended or moved to another role.

Rights are checked on the server for every Socket.IO request and every nested agent operation. A new
event is denied until it is explicitly allowed. A viewer receives a separate, safe set of stack list
fields. Account settings and one's own two factor setup are available to every role.

## Two-factor authentication

Every account can switch on a second factor under Settings -> Security: scan the code with an
authenticator app, enter one code to confirm, and save the backup codes that are shown once. From
then on a login asks for a six-digit code or one of the backup codes as well as the password. Setup
that is not finished leaves two-factor authentication off.

## A lost owner password

Another owner can reset it under Settings -> Users. When no owner can sign in, reset the accounts on
the host:

```sh
sudo docker exec -it dockge2-dockge-1 npm run reset-account
sudo docker restart dockge2-dockge-1
sudo docker exec dockge2-dockge-1 cat /app/data/bootstrap-token
```

The command asks before it removes **all accounts and their sessions**. Stacks, settings and agents
stay. After the restart the panel shows the setup screen again, and the new setup code creates a
replacement owner.

## HTTPS and a reverse proxy

For a public domain served through a TLS proxy, set:

```dotenv
DOCKGE_PUBLIC_URL=https://dockge.example.com
DOCKGE_SECURE_COOKIES=true
DOCKGE_TRUST_PROXY=true
```

`DOCKGE_PUBLIC_URL` has to be an HTTP(S) origin without a path and without credentials. An HTTPS
value turns Secure cookies on by itself, and switching Secure off explicitly with such an address
fails the start. `DOCKGE_SECURE_COOKIES=true` also works without a public URL, when TLS terminates
at the proxy.

`DOCKGE_TRUST_PROXY=true` is appropriate when only a trusted proxy can reach the application port
and that proxy overwrites incoming `X-Forwarded-*` headers. Close direct access to the Dockge2 port
in your network rules. Without this setting the proxy headers do not determine the client address
for the login rate limit. Extra browser origins, if any, are listed comma separated in
`DOCKGE_TRUSTED_ORIGINS`.

Logging in by email or username allows up to 10 attempts a minute per client address, and the
initial setup up to 3. Origin and CSRF checks and the rate limit stay on. Do not disable the origin
check with `DOCKGE_WS_ORIGIN_CHECK=bypass` on a public instance.

The "disable authentication" mode exists for an installation where all access is already protected by
an external gateway. In that mode a visitor acts as the owner, so per-user roles do not restrict
anonymous access. For ordinary public access, leave authentication on.

## Agents

Connecting to an agent logs in through the better-auth HTTP API by username or email, then passes the
resulting session to Socket.IO. Credentials in a URL are rejected. The session is kept on the server
and shared by every connection to the same agent with the same credentials, so concurrent tabs share
one login request. The cookie lifetime is respected, and a revoked session triggers a coordinated
re-login. A 429 response honours `Retry-After` and allows up to two retries, preserving the limit.

For an automatic connection, use a dedicated agent service account with the rights it needs.
Interactive second-factor entry is not supported over that connection: such an account fails with an
explicit error rather than having the owner's protection switched off. The local user's rights are
checked again before each operation is passed to an agent.

None of this publishes the instance to the internet or configures the reverse proxy itself.
