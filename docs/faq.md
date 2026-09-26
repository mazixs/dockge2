# FAQ

### Can I manage a single container without a Compose file?

No. A stack is a directory with a Compose file, and that is what keeps the files yours rather than
the panel's. For a single container use the Docker CLI, or paste its `docker run` command into
New stack -> Paste Compose to turn it into a stack.

### Can I manage the stacks I already have?

Yes, once the Compose file is inside the stacks directory:

1. Stop the stack.
2. Move its directory to `/opt/stacks/<name>/`, with the Compose file at its root.
3. Choose "Scan Stacks Folder" in the menu at the top right.
4. The stack appears in the list; start it from there.

A stack directory keeps working with plain `docker compose`, with or without the panel.

### Is `compose.yaml` the same as `docker-compose.yml`?

Yes. Both are [Compose V2](https://docs.docker.com/compose/migrate/) file names, and the panel
recognises `compose.yaml`, `compose.yml`, `docker-compose.yaml` and `docker-compose.yml`.

### Why does a stack need attention when its init container exited cleanly?

A service that exited with code 0 is a stopped service, unless it is marked as one-shot: a
migration, an init step or a job that is meant to finish. Mark it in the service with
`x-dockge: { lifecycle: one-shot }` (or the flat key `x-dockge.lifecycle: one-shot`), or with the
container label `dockge.lifecycle=one-shot` for a stack that was not created in the panel. A one-shot service that exits with another code is shown as
a failed job.

### Does Dockge2 phone home?

No. The release check is off until the owner runs it or enables automatic checks under
Settings -> About, and it asks only the GitHub releases of this repository.

### Why is the version 0.0.x when Dockge is 1.x?

Version numbering is this fork's own and started again at 0.0.1. A Dockge2 version says nothing
about upstream Dockge versions.

### Where do I report a bug?

In [the issues of this repository](https://github.com/mazixs/dockge2/issues), not upstream.
Vulnerabilities go through [the security policy](../.github/SECURITY.md), never a public issue.
