# Stacks from Git

A stack directory can be a Git checkout. The panel clones it, tells you how far behind its branch
the server copy is, and applies an update file by file, with you choosing each result.

## Deploy a stack from a repository

1. New stack -> From Git. Enter the repository address and the branch; "List branches" asks the
   repository for them.
2. Review and launch. Name the Compose file, or leave it empty to detect `compose.yaml`,
   `compose.yml`, `docker-compose.yaml` or `docker-compose.yml` at the repository root, and choose
   the env files.
3. Deploy, or save without starting to adjust the environment in the stack files first. The
   repository is cloned and Compose is validated before anything starts.

The address is HTTP(S), `ssh://` or `git@host:path`, with no password or token in it.

## Update a stack

When the branch moves ahead, the stack shows "behind" with the number of commits, and "edited" when
files on the server differ from Git. "Compare changes" opens the comparison:

![Comparison of the server copy with the new commit](assets/screenshots/git-compare.webp)

1. Every changed file is listed as added in Git, modified or deleted from Git, and shown side by
   side: "On server" and "From Git". Files that may hold secrets, such as `.env`, and binary files
   are compared without showing their contents.
2. For each file choose "Keep on server" or "Take from Git", or edit the result by hand. The draft
   stays in memory, and server files stay unchanged until you apply the result.
3. "Apply and deploy" validates Compose with the selected files, re-checks that the server files
   have not changed since the comparison, writes the result, pulls images and recreates the changed
   services. Saving without deploying is also possible.
4. The result shows what actually happened. A local version you kept keeps showing as different
   from Git.

Comments and formatting of the files are preserved, and nothing is pushed to the repository. A
comparison stays valid for 10 minutes; after that, or when the files changed meanwhile, the panel
asks for a new one.

## What is supported

- Fast-forward updates of one branch. Diverged branches are not merged.
- Regular files, with Compose and env files at the repository root. No submodules and no symlinks.
- Up to 1000 files, 1 MB per file and 20 MB in total.
- No implicit `reset --hard`, `clean` or stash. When a write fails, the original files are restored;
  after a crash in the middle of a write, the originals are in `.git/dockge-recovery-*` in the stack
  directory.
- Rolling files back does not roll container data back.

## Private repositories

The panel talks to Git directly, never to the GitHub API, and authenticates in one way only:

- No prompt is ever shown (`GIT_TERMINAL_PROMPT=0`), credential helpers are disabled and the global
  Git configuration is ignored. A command that would ask for a password fails instead of hanging.
- A token inside the repository address is rejected, so a secret cannot end up in the
  configuration, a list or a log.
- That leaves an SSH key without a passphrase, plus a `known_hosts` entry for the Git host, mounted
  into the panel container at `/root/.ssh`. The mount is set on
  [installation](installation.md#ssh-keys-registry-logins-and-certificates).

Without the key a private repository does not half work: the clone fails with the authentication
error from Git, and the panel shows it as it came.

## From the command line

A stack that is a Git checkout can also be updated from the host, with a command inside the panel
container. It fast-forwards the branch, validates Compose with the files named explicitly, pulls
the images and starts the stack, waiting up to 60 seconds for its health checks:

```bash
sudo docker exec dockge2-dockge-1 npm run deploy-stack -- --stack=my-stack --dry-run
sudo docker exec dockge2-dockge-1 npm run deploy-stack -- --stack=my-stack \
  --file=compose.yaml --env-file=.env --env-file=.env.production
```

| Option | Meaning |
| --- | --- |
| `--stack=NAME` | Stack directory inside the stacks directory, required |
| `--file=FILE` | Compose file, `compose.yaml` by default |
| `--env-file=FILE` | Env file for interpolation, repeatable, in order |
| `--branch=NAME` | Branch to fast-forward to, `main` by default |
| `--stacks-dir=DIR` | Stacks directory, `DOCKGE_STACKS_DIR` by default |
| `--skip-git` | Deploy a stack that is not a checkout |
| `--force-recreate` | Recreate the containers even without changes |
| `--dry-run` | Print the commands without running them |

It stops when the stack directory has local changes and never runs `git reset` or `git clean`.
It is an administrative command for the host; the browser has no event that runs arbitrary Git.
