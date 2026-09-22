############################################
# Healthcheck Binary
############################################
# Built on the machine that runs the build, not under emulation: healthcheck.go
# is plain Go with no cgo, so cross compiling it for the target is both correct
# and minutes faster than running a foreign toolchain through QEMU.
FROM --platform=$BUILDPLATFORM golang:1.27.0-bookworm AS build_healthcheck
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
WORKDIR /app
COPY ./extra/healthcheck.go ./extra/healthcheck.go
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOARM=${TARGETVARIANT#v} \
    go build -o ./extra/healthcheck ./extra/healthcheck.go

############################################
# Base
############################################
# The base of every other stage, built here rather than pulled: an image that
# lives only in a registry makes a fresh install depend on that registry being
# reachable and on someone having pushed it. Nothing below needs an account
# anywhere, so `docker compose build` works on a bare server.
#
# The panel shells out to `docker compose`, so the CLI and the compose plugin
# are part of the runtime, not of the build. git and ssh are here for the same
# reason: a stack from a repository is a product feature.
FROM node:24.19.0-bookworm-slim AS base
RUN apt update && apt install --yes --no-install-recommends \
    curl \
    ca-certificates \
    gnupg \
    unzip \
    dumb-init \
    git \
    openssh-client \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo \
         "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
         "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
         tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt update \
    && apt --yes --no-install-recommends install \
         docker-ce-cli \
         docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

############################################
# Build
############################################
FROM base AS build
WORKDIR /app
COPY --chown=node:node  ./package.json ./package.json
COPY --chown=node:node  ./package-lock.json ./package-lock.json
# --ignore-scripts is required: the base image has no python and no compiler,
# and npm would otherwise run node-gyp for better-sqlite3. There is nothing to
# compile - the binaries ship inside the packages themselves
# (better-sqlite3/prebuilds, node-pty-prebuilt-multiarch/prebuilds), and
# node-gyp-build picks them up at run time.
RUN npm ci --omit=dev --ignore-scripts

############################################
# Frontend
############################################
# The frontend is built here rather than on the host: installing on a bare
# server must need Docker and nothing else, no Node and no npm. A stage of its
# own keeps vite and its dependencies out of the final image.
#
# Runs on the build machine for every target architecture. The output is static
# files, identical whatever the target is, and the bundler needs about a
# gigabyte of memory: under emulation that is both slow and the most likely
# thing to be killed by the out-of-memory reaper on a small machine. Plain node
# is enough here - the docker CLI from `base` is of no use to a bundler.
FROM --platform=$BUILDPLATFORM node:24.19.0-bookworm-slim AS build_frontend
WORKDIR /app
COPY --chown=node:node  ./package.json ./package.json
COPY --chown=node:node  ./package-lock.json ./package-lock.json
RUN npm ci --ignore-scripts
COPY --chown=node:node  . .
RUN npm run build:frontend

############################################
# ⭐ Main Image
############################################
FROM base AS release
WORKDIR /app
COPY --chown=node:node --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck
COPY --from=build /app/node_modules /app/node_modules
COPY --chown=node:node  . .
COPY --chown=node:node --from=build_frontend /app/frontend-dist /app/frontend-dist
RUN mkdir ./data


# It is just for safe, as by default, it is disabled in the latest Node.js now.
# Read more:
# - https://github.com/sagemathinc/cocalc/issues/6963
# - https://github.com/microsoft/node-pty/issues/630#issuecomment-1987212447
ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 5001
HEALTHCHECK --interval=10s --timeout=6s --start-period=60s --retries=3 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "--import", "tsx", "./backend/index.ts"]

############################################
# Mark as Nightly
############################################
FROM release AS nightly
RUN npm run mark-as-nightly
