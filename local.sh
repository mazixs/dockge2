#!/usr/bin/env bash
#
# Локальная разработка dockge2: пересоздает контейнеры docker-compose.local.yml
# и запускает npm run dev внутри контейнера.
#
#   ./local.sh        - запуск с логами в терминале, Ctrl+C останавливает
#   ./local.sh -d     - запуск в фоне
#
set -euo pipefail

# Скрипт должен работать из любой директории, поэтому идем в корень проекта
# относительно самого файла, а не относительно текущего каталога.
PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

COMPOSE_FILE="docker-compose.local.yml"
# Имя проекта фиксировано: все операции ниже ограничены только им, чужие
# контейнеры на машине скрипт не трогает.
PROJECT_NAME="dockge2-local"
DEFAULT_STACKS_DIR="/tmp/dockge2-stacks"

fail() {
    echo "Ошибка: $1" >&2
    exit 1
}

if ! command -v docker >/dev/null 2>&1; then
    fail "не найден docker. Установите Docker Engine: https://docs.docker.com/engine/install/"
fi

if ! docker compose version >/dev/null 2>&1; then
    fail "не найден плагин Docker Compose v2. Проверьте команду: docker compose version"
fi

if ! docker info >/dev/null 2>&1; then
    fail "демон Docker не отвечает. Запустите его и проверьте права на /var/run/docker.sock"
fi

[ -f "$COMPOSE_FILE" ] || fail "рядом со скриптом нет файла $COMPOSE_FILE"

# .env docker compose подхватывает сам, а .env.local - нет, поэтому оба
# передаются явно. Порядок важен: значения из .env.local перекрывают .env.
ENV_ARGS=()
for env_file in .env .env.local; do
    if [ -f "$env_file" ]; then
        ENV_ARGS+=(--env-file "$env_file")
    fi
done

# Значение переменной из env-файлов читаем текстом, а не через source:
# env-файл - это данные, исполнять его содержимое незачем.
read_env_var() {
    local key="$1" file line value=""
    for file in .env .env.local; do
        [ -f "$file" ] || continue
        line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
        if [ -n "$line" ]; then
            value="${line#*=}"
            value="${value%\"}"
            value="${value#\"}"
            value="${value%\'}"
            value="${value#\'}"
        fi
    done
    printf '%s' "$value"
}

# Переменные окружения имеют приоритет над env-файлами - так же, как в compose.
STACKS_DIR="${DOCKGE_LOCAL_STACKS_DIR:-$(read_env_var DOCKGE_LOCAL_STACKS_DIR)}"
STACKS_DIR="${STACKS_DIR:-$DEFAULT_STACKS_DIR}"
# Каталог создаем сами, иначе Docker сделает его владельцем root.
mkdir -p "$STACKS_DIR"

# Файлы стеков должны принадлежать текущему пользователю, а не root в контейнере.
export PUID="${PUID:-$(id -u)}"
export PGID="${PGID:-$(id -g)}"

compose() {
    docker compose -p "$PROJECT_NAME" -f "$COMPOSE_FILE" \
        ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} "$@"
}

DETACH="no"
UP_ARGS=(up --build --force-recreate)
case "${1:-}" in
    -d|--detach)
        DETACH="yes"
        UP_ARGS+=(--detach)
        ;;
    "")
        ;;
    *)
        fail "неизвестный аргумент \"$1\". Доступно: -d (--detach)"
        ;;
esac

echo "==> Останавливаю прошлый запуск проекта $PROJECT_NAME"
# down без -v: тома с node_modules и данными сохраняются.
# Если контейнеров нет, команда просто ничего не делает и возвращает 0.
compose down --remove-orphans

echo "==> Каталог стеков: $STACKS_DIR"
echo "==> Поднимаю контейнеры заново"
compose "${UP_ARGS[@]}"

if [ "$DETACH" = "yes" ]; then
    echo "==> Интерфейс: http://localhost:5000, бэкенд: http://localhost:5001"
    echo "==> Логи:      docker compose -p $PROJECT_NAME -f $COMPOSE_FILE logs -f"
    echo "==> Остановка: docker compose -p $PROJECT_NAME -f $COMPOSE_FILE down"
fi
