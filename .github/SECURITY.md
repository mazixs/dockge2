# Security Policy

## Reporting a Vulnerability

1. Please report security issues privately at https://github.com/mazixs/dockge2/security/advisories/new.
1. Please also create an empty [security issue](https://github.com/mazixs/dockge2/issues/new?assignees=&labels=security&template=security.md) to alert the maintainers: GitHub Advisories do not send a notification, and the report can go unnoticed without it.

Do not use the public issue tracker and do not discuss the problem in public before a fix is released: that causes more damage than the delay.

## Third-party bug bounty platforms

Reports are accepted through GitHub Advisories only. Emails from third-party bug bounty platforms are ignored, because they cannot be told apart from phishing.

## Supported versions

Only the latest released version is supported. Dockge2 is a fork and does not share a security process with upstream Dockge: do not report issues of this fork to the upstream project, and do not expect fixes of this fork to reach upstream.

## What is in scope

- The panel itself: authentication, sessions, access levels, MCP keys, secrets, stack file handling.
- The published Docker image and the compose files in this repository.

Out of scope: the Docker daemon, images of stacks you deploy, and anything a host owner can already do with shell access. Dockge2 executes `docker compose` on behalf of owners and operators by design; that is a documented capability, not a vulnerability.
