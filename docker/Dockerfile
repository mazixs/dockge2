############################################
# Healthcheck Binary
############################################
FROM mazixs/dockge2:build-healthcheck AS build_healthcheck

############################################
# Build
############################################
FROM mazixs/dockge2:base AS build
WORKDIR /app
COPY --chown=node:node  ./package.json ./package.json
COPY --chown=node:node  ./package-lock.json ./package-lock.json
# --ignore-scripts обязателен: в базовом образе нет python и компилятора, а npm
# иначе запускает node-gyp для better-sqlite3. Собирать нечего - готовые бинарники
# лежат в самих пакетах (better-sqlite3/prebuilds, node-pty-prebuilt-multiarch/prebuilds),
# и node-gyp-build подхватывает их во время выполнения.
RUN npm ci --omit=dev --ignore-scripts

############################################
# ⭐ Main Image
############################################
FROM mazixs/dockge2:base AS release
WORKDIR /app
COPY --chown=node:node --from=build_healthcheck /app/extra/healthcheck /app/extra/healthcheck
COPY --from=build /app/node_modules /app/node_modules
COPY --chown=node:node  . .
RUN mkdir ./data


# It is just for safe, as by default, it is disabled in the latest Node.js now.
# Read more:
# - https://github.com/sagemathinc/cocalc/issues/6963
# - https://github.com/microsoft/node-pty/issues/630#issuecomment-1987212447
ENV UV_USE_IO_URING=0

VOLUME /app/data
EXPOSE 5001
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "--import", "tsx", "./backend/index.ts"]

############################################
# Mark as Nightly
############################################
FROM release AS nightly
RUN npm run mark-as-nightly
