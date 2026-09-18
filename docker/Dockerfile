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
# Frontend
############################################
# Фронтенд собирается здесь, а не на хосте: установка на чистом сервере не
# должна требовать ни Node, ни npm - только Docker. Отдельная ступень нужна,
# чтобы vite и его зависимости остались за пределами итогового образа.
FROM mazixs/dockge2:base AS build_frontend
WORKDIR /app
COPY --chown=node:node  ./package.json ./package.json
COPY --chown=node:node  ./package-lock.json ./package-lock.json
RUN npm ci --ignore-scripts
COPY --chown=node:node  . .
RUN npm run build:frontend

############################################
# ⭐ Main Image
############################################
FROM mazixs/dockge2:base AS release
WORKDIR /app
# Стеки из Git - часть продукта: без git и ssh панель не может ни склонировать
# стек, ни сказать, отстал ли он от ветки. Ставится здесь, а не только в
# Base.Dockerfile, потому что базовый образ публикуется отдельно и редко;
# когда он выйдет с этими пакетами, apt здесь просто ничего не сделает
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git openssh-client \
    && rm -rf /var/lib/apt/lists/*
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
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 CMD extra/healthcheck
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "--import", "tsx", "./backend/index.ts"]

############################################
# Mark as Nightly
############################################
FROM release AS nightly
RUN npm run mark-as-nightly
