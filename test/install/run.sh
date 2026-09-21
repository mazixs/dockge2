#!/usr/bin/env bash
#
# Runs install.sh against a docker stub and a local Git origin, one scenario per
# function, and checks what the installer printed, wrote and left behind.
# No container, image or directory outside a temporary work directory is touched;
# sudo is a stub that just runs the command, since everything here belongs to
# the current user anyway.
#
#   test/install/run.sh            all scenarios
#   test/install/run.sh <name>     one scenario, by function name
#
set -uo pipefail

REPO="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dockge2-install-test.XXXXXX")"
trap '[ -n "${KEEP:-}" ] && printf "work dir kept: %s\n" "$WORK" || rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
CURRENT=""

fail() { FAIL=$((FAIL + 1)); printf '  FAIL %s: %s\n' "$CURRENT" "$*"; }
ok()   { PASS=$((PASS + 1)); }
expect_grep() {
    # expect_grep <pattern> <file> <what>
    if grep -qE -- "$1" "$2"; then ok; else fail "$3 (no /$1/ in output)"; fi
}
expect_no_grep() {
    if grep -qE -- "$1" "$2"; then fail "$3 (unexpected /$1/ in output)"; else ok; fi
}
expect_eq() {
    # expect_eq <actual> <expected> <what>
    if [ "$1" = "$2" ]; then ok; else fail "$3: got '$1', wanted '$2'"; fi
}
expect_exists() {
    # expect_exists <path> <what>
    if [ -e "$1" ]; then ok; else fail "$2 ($1 is missing)"; fi
}
expect_missing() {
    if [ -e "$1" ]; then fail "$2 ($1 exists)"; else ok; fi
}

########################################
# Stubs
########################################
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
# Every call is logged; behaviour is switched by STUB_* variables
echo "docker $*" >> "$STUB_LOG"
case "$*" in
    "info") exit 0 ;;
    info*DockerRootDir*) echo "$STUB_ROOT" ;;
    "version --format {{.Server.Version}}") echo 27.1.0 ;;
    "--version") echo "Docker version 27.1.0" ;;
    "compose version --short") echo "v${STUB_COMPOSE:-2.29.0}" ;;
    "compose version") echo "Docker Compose version v${STUB_COMPOSE:-2.29.0}" ;;
    "ps --format {{.Names}}") : ;;
    "ps -a --filter label=com.docker.compose.project=dockge2 --format {{.Names}}") [ "${STUB_OTHER_PROJECT:-0}" = "1" ] && echo dockge2-dockge-1 ;;
    "image inspect "*) [ "${STUB_HAS_IMAGE:-1}" = "1" ]; exit $? ;;
    "pull "*) [ "${STUB_PULL_OK:-0}" = "1" ] || { echo "Error response from daemon: manifest unknown" >&2; exit 1; }; echo "$2" >> "$STUB_PULLED" ;;
    "tag "*) echo "$3" >> "$STUB_TAGS" ;;
    "image ls --format {{.Repository}}:{{.Tag}} dockge2") [ -f "$STUB_TAGS" ] && cat "$STUB_TAGS" ;;
    "image rm "*) if grep -qx "$3" "$STUB_TAGS" 2>/dev/null; then grep -vx "$3" "$STUB_TAGS" > "$STUB_TAGS.new"; mv "$STUB_TAGS.new" "$STUB_TAGS"; else exit 1; fi ;;
    "compose -f docker-compose.yml config --quiet") exit 0 ;;
    "compose -f docker-compose.yml build") [ "${STUB_FAIL_BUILD:-0}" = "0" ] || { echo "ERROR: no space left on device" >&2; exit 1; } ;;
    "compose -f docker-compose.yml up -d"*) [ "${STUB_FAIL_UP:-0}" = "0" ] || { echo "container dockge2-dockge-1 is unhealthy" >&2; exit 1; } ;;
    "compose -f docker-compose.yml ps --format {{.Ports}}") echo "0.0.0.0:${STUB_PUBLISHED}->${STUB_PUBLISHED}/tcp, [::]:${STUB_PUBLISHED}->${STUB_PUBLISHED}/tcp" ;;
    "compose -f docker-compose.yml ps --format {{.Name}} {{.State}} {{.Status}}") echo "dockge2-dockge-1 running Up 2 minutes (unhealthy)" ;;
    "compose -f docker-compose.yml logs --tail 40") echo "stub log line" ;;
    "compose -f docker-compose.yml exec -T dockge cat /app/data/bootstrap-token") [ "${STUB_NO_TOKEN:-0}" = "0" ] || exit 1; echo "stub-setup-code" ;;
    "system df --format {{.Type}}"*) printf 'Images\t867MB\nBuild Cache\t%s\n' "${STUB_CACHE:-3.055GB}" ;;
esac
exit 0
EOF
# sudo -n true is how the installer asks whether sudo would prompt: it would not.
# Root reads any file; here that is emulated by lifting the mode for the read,
# which is the one thing an owner can do that root would not need to
cat > "$WORK/bin/sudo" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "-n" ] && shift
if [ "${1:-}" = "cat" ] && [ -n "${2:-}" ] && [ ! -r "$2" ]; then
    mode="$(stat -c %a "$2")"
    chmod u+r "$2" && cat "$2"; code=$?
    chmod "$mode" "$2"
    exit "$code"
fi
exec "$@"
EOF
chmod +x "$WORK/bin/docker" "$WORK/bin/sudo"

# A port nothing listens on, so that the "port is taken" branch is a scenario
# rather than an accident of the machine
free_port() {
    local p=5601
    while ss -ltn "sport = :$p" 2>/dev/null | grep -q LISTEN; do p=$((p + 1)); done
    printf '%s' "$p"
}
PORT="$(free_port)"

# The origin is this repository's own installer, compose file and Dockerfile,
# with two commits so that fetch and fast-forward have something to do
ORIGIN="$WORK/origin"
mkdir -p "$ORIGIN/docker"
cp "$REPO/install.sh" "$REPO/docker-compose.yml" "$ORIGIN/"
cp "$REPO/docker/Dockerfile" "$ORIGIN/docker/"
git -C "$ORIGIN" init -q -b main
git -C "$ORIGIN" -c user.email=t@t -c user.name=t add -A
git -C "$ORIGIN" -c user.email=t@t -c user.name=t commit -qm "one"
echo second > "$ORIGIN/second"
git -C "$ORIGIN" -c user.email=t@t -c user.name=t add -A
git -C "$ORIGIN" -c user.email=t@t -c user.name=t commit -qm "two"
# A fresh install runs the downloaded copy, as the README says to; running the
# one inside the origin would make the installer take the origin for a checkout
INSTALLER="$WORK/download/install.sh"
mkdir -p "$WORK/download" && cp "$REPO/install.sh" "$INSTALLER"

OLD_COMMIT="$(git -C "$ORIGIN" rev-parse --short HEAD~1)"
NEW_COMMIT="$(git -C "$ORIGIN" rev-parse --short HEAD)"

########################################
# Running the installer
########################################
N=0
run() {
    # run <install.sh path> <args...>: output in $OUT, exit code in $CODE
    N=$((N + 1))
    OUT="$WORK/out-$N.txt"
    STUB_LOG="$WORK/log-$N.txt"
    : > "$STUB_LOG"
    PATH="$WORK/bin:$PATH" STUB_LOG="$STUB_LOG" STUB_ROOT="$WORK" STUB_TAGS="$WORK/tags" \
        STUB_PULL_OK="${STUB_PULL_OK:-0}" STUB_PULLED="$WORK/pulled" \
        STUB_PUBLISHED="${STUB_PUBLISHED:-$PORT}" STUB_HAS_IMAGE="${STUB_HAS_IMAGE:-1}" \
        STUB_FAIL_BUILD="${STUB_FAIL_BUILD:-0}" STUB_FAIL_UP="${STUB_FAIL_UP:-0}" STUB_COMPOSE="${STUB_COMPOSE:-2.29.0}" DOCKGE2_REPO="$ORIGIN" \
        bash "$@" > "$OUT" 2>&1 < /dev/null
    CODE=$?
}

# run_tty <keystrokes> <install.sh path> <args...>: the same through a
# pseudo-terminal, so that the questions read from /dev/tty get the keystrokes
HAVE_TTY=0
command -v script >/dev/null 2>&1 && HAVE_TTY=1
run_tty() {
    local keys="$1"; shift
    N=$((N + 1))
    OUT="$WORK/out-$N.txt"
    STUB_LOG="$WORK/log-$N.txt"
    : > "$STUB_LOG"
    printf '%b' "$keys" | PATH="$WORK/bin:$PATH" STUB_LOG="$STUB_LOG" STUB_ROOT="$WORK" \
        STUB_TAGS="$WORK/tags" STUB_PULL_OK="${STUB_PULL_OK:-0}" STUB_PULLED="$WORK/pulled" \
        STUB_PUBLISHED="${STUB_PUBLISHED:-$PORT}" STUB_HAS_IMAGE="${STUB_HAS_IMAGE:-1}" \
        STUB_FAIL_BUILD="${STUB_FAIL_BUILD:-0}" STUB_FAIL_UP="${STUB_FAIL_UP:-0}" STUB_COMPOSE="${STUB_COMPOSE:-2.29.0}" DOCKGE2_REPO="$ORIGIN" \
        script -qfec "bash $*" /dev/null 2>&1 | tr -d '\r' > "$OUT"
    CODE=${PIPESTATUS[1]}
}

fresh() {
    # fresh <dir>: a finished installation to run the update scenarios against
    rm -f "$WORK/tags"
    STUB_HAS_IMAGE=0 run "$INSTALLER" --yes --port "$PORT" --dir "$1" --stacks-dir "$WORK/stacks"
}

########################################
# Scenarios
########################################

scenario_fresh_install() {
    fresh "$WORK/s1"
    expect_eq "$CODE" 0 "exit code"
    expect_grep "Dockge2 is running" "$OUT" "final banner"
    expect_grep "http://127.0.0.1:$PORT" "$OUT" "address with the chosen port"
    expect_grep "stub-setup-code" "$OUT" "setup code printed"
    expect_eq "$(sed -n 's/^DOCKGE_PORT=//p' "$WORK/s1/.env")" "$PORT" ".env port"
    expect_eq "$(sed -n 's/^DOCKGE_STACKS_DIR=//p' "$WORK/s1/.env")" "$WORK/stacks" ".env stacks dir"
    expect_eq "$(stat -c %a "$WORK/s1/.env")" 600 ".env mode"
    expect_grep "compose -f docker-compose.yml build" "$STUB_LOG" "build ran"
    expect_grep "compose -f docker-compose.yml up -d --wait --wait-timeout 180" "$STUB_LOG" "up with a deadline"
    expect_no_grep "docker tag" "$STUB_LOG" "no rollback tag when there was no image"
    expect_exists "$WORK/stacks" "stacks dir created"
}

scenario_build_says_what_the_cache_costs() {
    # A build leaves gigabytes of cache behind, which is a surprise on the small
    # disk the published image exists to spare. Saying it is all the installer
    # does - pruning is the user's call
    fresh "$WORK/cache"
    expect_grep "Build cache:" "$OUT" "the cache is named after a build"
    expect_grep "3.055GB" "$OUT" "with its size"
    expect_grep "docker builder prune" "$OUT" "and how to free it"
    expect_no_grep "builder prune -f$" "$STUB_LOG" "but nothing is pruned"
}

scenario_a_downloaded_image_leaves_no_cache_to_mention() {
    # A prefix assignment in front of a function call outlives the call in bash,
    # so the variable is passed to run the way every other scenario does it
    rm -f "$WORK/tags"
    STUB_HAS_IMAGE=0 STUB_PULL_OK=1 run "$INSTALLER" --yes --port "$PORT" --dir "$WORK/cache2" --stacks-dir "$WORK/stacks"
    expect_eq "$CODE" 0 "exit code"
    expect_grep "Downloaded" "$OUT" "the image came from the registry"
    expect_no_grep "Build cache:" "$OUT" "nothing was built, so no cache is mentioned"
}

scenario_no_terminal_without_yes() {
    run "$INSTALLER" --dir "$WORK/never"
    expect_eq "$CODE" 1 "exit code"
    expect_grep "no terminal" "$OUT" "asks for --yes"
    expect_missing "$WORK/never" "nothing created"
    # The shell reports a failed redirection through the stderr it has at that
    # moment, so testing for a terminal the wrong way round printed
    # "/dev/tty: No such device or address" before our own message
    # Matched on the path, not on the wording: the shell translates the message
    # and an English pattern passes silently under any other locale
    expect_no_grep "/dev/tty" "$OUT" "no raw shell error before the message"
}

scenario_update_keeps_env_and_prunes_tags() {
    fresh "$WORK/s2"
    git -C "$WORK/s2" reset -q --hard "$OLD_COMMIT"
    printf 'dockge2:rollback-20200101-000000\n' > "$WORK/tags"
    run "$WORK/s2/install.sh" --update --yes
    expect_eq "$CODE" 0 "exit code"
    expect_grep "Now at $NEW_COMMIT on main" "$OUT" "fast-forwarded to origin"
    expect_grep "keeps every setting" "$OUT" ".env kept"
    expect_eq "$(sed -n 's/^DOCKGE_PORT=//p' "$WORK/s2/.env")" "$PORT" ".env port unchanged"
    expect_grep "Older rollback tag removed: dockge2:rollback-20200101-000000" "$OUT" "old tag removed"
    expect_eq "$(grep -c '^dockge2:rollback-' "$WORK/tags")" 1 "exactly one rollback tag left"
    expect_grep "Previous image: dockge2:rollback-" "$OUT" "the kept tag is named"
}

scenario_update_without_a_setup_code_still_finishes() {
    # Once an owner exists the token file is gone, so reading it fails. That is
    # the normal state of every update, and it used to end the run under
    # `pipefail` one step before the closing lines - leaving the caller with a
    # non-zero exit code and no rollback image named, for a panel that had in
    # fact just started
    fresh "$WORK/s2b"
    STUB_NO_TOKEN=1 run "$WORK/s2b/install.sh" --update --yes
    expect_eq "$CODE" 0 "exit code"
    expect_grep "already has an owner" "$OUT" "says why there is no code"
    expect_grep "Update later:" "$OUT" "reached the closing lines"
}

scenario_update_port_option_rewrites_env() {
    fresh "$WORK/s3"
    local other=$((PORT + 1))
    STUB_PUBLISHED="$other" run "$WORK/s3/install.sh" --update --yes --port "$other"
    expect_eq "$CODE" 0 "exit code"
    expect_eq "$(sed -n 's/^DOCKGE_PORT=//p' "$WORK/s3/.env")" "$other" ".env port rewritten"
    expect_grep "DOCKGE_PORT is now $other" "$OUT" "says so"
    expect_grep "http://127.0.0.1:$other" "$OUT" "address with the new port"
}

scenario_unreadable_env_is_read_through_sudo() {
    fresh "$WORK/s4"
    chmod 000 "$WORK/s4/.env"
    local other=$((PORT + 2))
    STUB_PUBLISHED="$other" run "$WORK/s4/install.sh" --update --yes --port "$other"
    chmod 600 "$WORK/s4/.env" 2>/dev/null
    expect_eq "$CODE" 0 "exit code"
    expect_no_grep "awk: cannot open" "$OUT" "no awk crash"
    expect_grep "belongs to another user; it is read through sudo" "$OUT" "explains the sudo read"
    expect_eq "$(sed -n 's/^DOCKGE_STACKS_DIR=//p' "$WORK/s4/.env")" "$WORK/stacks" "stacks dir came from .env, not the default"
    expect_eq "$(sed -n 's/^DOCKGE_PORT=//p' "$WORK/s4/.env")" "$other" "port option applied"
    expect_eq "$(stat -c %a "$WORK/s4/.env")" 600 ".env readable again"
}

scenario_update_of_nothing_stops() {
    run "$INSTALLER" --update --yes --port "$PORT" --dir "$WORK/nothing"
    expect_eq "$CODE" 1 "exit code"
    expect_grep "is not a dockge2 checkout" "$OUT" "names the reason"
    expect_missing "$WORK/nothing" "nothing created"
}

scenario_failed_clone_removes_only_its_own_directory() {
    run "$INSTALLER" --yes --port "$PORT" --dir "$WORK/half" --stacks-dir "$WORK/stacks" --branch does-not-exist
    expect_eq "$CODE" 1 "exit code"
    expect_grep "Could not clone" "$OUT" "clone error"
    expect_grep "Removing the half-written" "$OUT" "cleanup announced"
    expect_missing "$WORK/half" "directory removed"

    mkdir -p "$WORK/mine"
    run "$INSTALLER" --yes --port "$PORT" --dir "$WORK/mine" --stacks-dir "$WORK/stacks" --branch does-not-exist
    expect_eq "$CODE" 1 "exit code"
    expect_grep "Emptying the half-written" "$OUT" "emptying announced"
    expect_exists "$WORK/mine" "the user's own directory is kept"
    expect_eq "$(find "$WORK/mine" -mindepth 1 | wc -l | tr -d ' ')" 0 "and it is empty"
}

scenario_foreign_directory_refused() {
    mkdir -p "$WORK/foreign"; echo x > "$WORK/foreign/file"
    run "$INSTALLER" --yes --port "$PORT" --dir "$WORK/foreign" --stacks-dir "$WORK/stacks"
    expect_eq "$CODE" 1 "exit code"
    expect_grep "exists and is not empty" "$OUT" "refused"
    expect_exists "$WORK/foreign/file" "the file is untouched"
}

scenario_diverged_branch_stops() {
    fresh "$WORK/s5"
    echo local > "$WORK/s5/local-commit"
    git -C "$WORK/s5" -c user.email=t@t -c user.name=t add -A
    git -C "$WORK/s5" -c user.email=t@t -c user.name=t commit -qm "local"
    git -C "$WORK/s5" reset -q --soft "$OLD_COMMIT" && git -C "$WORK/s5" -c user.email=t@t -c user.name=t commit -qm "diverged" >/dev/null
    run "$WORK/s5/install.sh" --update --yes
    expect_eq "$CODE" 1 "exit code"
    expect_grep "cannot be fast-forwarded" "$OUT" "names the reason"
    expect_no_grep "compose -f docker-compose.yml build" "$STUB_LOG" "no build"
    # A dead end with no way out of it is what made this case a support request:
    # the way to look at both sides, the way to take origin, and the way to
    # update nothing but the image all belong in the message
    expect_grep "log --oneline --left-right HEAD...origin/main" "$OUT" "how to see both sides"
    expect_grep "diff --stat HEAD origin/main" "$OUT" "how to see whether files differ"
    expect_grep "reset --hard origin/main" "$OUT" "how to take origin when only the history differs"
    expect_grep "backup-" "$OUT" "a copy of the data first"
    expect_grep "[-][-]image-only" "$OUT" "the way that needs no Git at all"
}

scenario_image_only_leaves_the_checkout_alone() {
    # The panel runs from an image; the checkout only holds the compose file.
    # So a broken Git half must not stop an update of the image
    fresh "$WORK/s19"
    git -C "$WORK/s19" reset -q --hard "$OLD_COMMIT"
    STUB_PULL_OK=1 run "$WORK/s19/install.sh" --image-only --yes
    expect_eq "$CODE" 0 "exit code"
    expect_eq "$(git -C "$WORK/s19" rev-parse --short HEAD)" "$OLD_COMMIT" "HEAD not moved"
    expect_grep "updates the image and nothing else" "$OUT" "says what it did not do"
    expect_no_grep "Updating the checkout" "$OUT" "does not claim to update the checkout"
    expect_no_grep "Now at" "$OUT" "claims no fast-forward"
    expect_grep "Dockge2 is running" "$OUT" "the panel is up"
    expect_grep "compose -f docker-compose.yml up -d" "$STUB_LOG" "restarted"
}

scenario_image_only_works_on_a_detached_head() {
    # Where --update stops on purpose, --image-only is the way through: after a
    # rollback the checkout stands on a commit, and that is not a reason to be
    # stuck with the image of that rollback
    fresh "$WORK/s20"
    git -C "$WORK/s20" checkout -q "$OLD_COMMIT"
    STUB_PULL_OK=1 run "$WORK/s20/install.sh" --image-only --yes
    expect_eq "$CODE" 0 "exit code"
    expect_eq "$(git -C "$WORK/s20" rev-parse --short HEAD)" "$OLD_COMMIT" "still on that commit"
    expect_no_grep "checked out at a commit" "$OUT" "does not stop"
}

scenario_detached_head_stops() {
    fresh "$WORK/s6"
    git -C "$WORK/s6" checkout -q "$OLD_COMMIT"
    run "$WORK/s6/install.sh" --update --yes
    expect_eq "$CODE" 1 "exit code"
    expect_grep "checked out at a commit, not a branch" "$OUT" "names the state"
    expect_grep "git -C $WORK/s6 checkout main" "$OUT" "tells how to get back"
    expect_no_grep "Now at .* on main" "$OUT" "does not claim a branch"
    expect_eq "$(git -C "$WORK/s6" rev-parse --short HEAD)" "$OLD_COMMIT" "HEAD not moved"
}

scenario_uncommitted_changes_without_yes_are_not_forced() {
    fresh "$WORK/s7"
    echo edit >> "$WORK/s7/docker-compose.yml"
    run "$WORK/s7/install.sh" --update --yes
    expect_eq "$CODE" 0 "exit code with --yes"
    expect_grep "uncommitted changes" "$OUT" "warned"
    expect_grep "edit" "$WORK/s7/docker-compose.yml" "the edit is still there"
}

scenario_failed_build_offers_the_way_back() {
    fresh "$WORK/s8"
    STUB_FAIL_BUILD=1 run "$WORK/s8/install.sh" --update --yes
    expect_eq "$CODE" 1 "exit code"
    expect_grep "The build failed" "$OUT" "names the step"
    expect_grep "no space left on $WORK" "$OUT" "lists the usual reason with the docker root"
    expect_grep "git -C $WORK/s8 checkout $NEW_COMMIT" "$OUT" "commit to go back to"
    expect_grep "DOCKGE_IMAGE=dockge2:rollback-" "$OUT" "image to go back to"
    expect_grep "is untouched" "$OUT" "says nothing was replaced"
}

scenario_unhealthy_start_shows_state_and_logs() {
    fresh "$WORK/s9"
    STUB_FAIL_UP=1 run "$WORK/s9/install.sh" --update --yes
    expect_eq "$CODE" 1 "exit code"
    expect_grep "did not report itself healthy" "$OUT" "names the state"
    expect_grep "stub log line" "$OUT" "shows the logs"
    expect_grep "did not come up" "$OUT" "final message"
}

scenario_old_compose_has_no_wait_timeout() {
    STUB_COMPOSE=2.16.0 run "$INSTALLER" --yes --port "$PORT" --dir "$WORK/s10" --stacks-dir "$WORK/stacks"
    expect_eq "$CODE" 0 "exit code"
    expect_grep "has no --wait-timeout" "$OUT" "warned"
    expect_grep "up -d --wait$" "$STUB_LOG" "up without the flag"
}

scenario_taken_port_without_terminal_suggests_another() {
    local taken
    taken="$(ss -ltn 2>/dev/null | awk 'NR>1 {sub(/.*:/, "", $4); print $4}' | grep -E '^[0-9]+$' | head -1)"
    if [ -z "$taken" ]; then
        printf '  skip %s: nothing listens on this machine\n' "$CURRENT"; return
    fi
    run "$INSTALLER" --yes --port "$taken" --dir "$WORK/s11" --stacks-dir "$WORK/stacks"
    expect_eq "$CODE" 1 "exit code"
    expect_grep "Port $taken is already taken" "$OUT" "names the port"
    expect_grep "pass --port [0-9]+" "$OUT" "suggests one"
}

scenario_review_menu_on_existing_installation() {
    if [ "$HAVE_TTY" = "0" ]; then printf '  skip %s: no script(1)\n' "$CURRENT"; return; fi
    fresh "$WORK/s12"
    local before; before="$(sed -n 's/^DOCKGE_DATA_DIR=//p' "$WORK/s12/.env")"
    # 3 is refused, 2 is refused, 1 is refused, Enter continues
    run_tty '3\n2\n1\n\n' "$WORK/s12/install.sh" --update
    expect_eq "$CODE" 0 "exit code"
    expect_grep "Moving the data directory here would start the panel with an empty database" "$OUT" "3 refused"
    expect_grep "Moving the stacks directory would leave your stacks" "$OUT" "2 refused"
    expect_grep "cannot be moved from here" "$OUT" "1 refused"
    expect_eq "$(sed -n 's/^DOCKGE_DATA_DIR=//p' "$WORK/s12/.env")" "$before" "data dir unchanged"
    expect_grep "Dockge2 is running" "$OUT" "continued after Enter"
}

scenario_review_menu_quit_changes_nothing() {
    if [ "$HAVE_TTY" = "0" ]; then printf '  skip %s: no script(1)\n' "$CURRENT"; return; fi
    run_tty "$WORK/s13\n$WORK/stacks\n$PORT\nq\n" "$INSTALLER"
    expect_eq "$CODE" 1 "exit code"
    expect_grep "Nothing was changed" "$OUT" "quit message"
    expect_missing "$WORK/s13" "nothing created"
    expect_no_grep "git clone" "$STUB_LOG" "no docker call after quit"
}

scenario_review_menu_fixes_a_bad_path_and_port() {
    if [ "$HAVE_TTY" = "0" ]; then printf '  skip %s: no script(1)\n' "$CURRENT"; return; fi
    # relative path -> asked again; bad port -> asked again; then Enter
    run_tty "relative/path\n$WORK/s14\n$WORK/stacks\nabc\n$PORT\n\n" "$INSTALLER"
    expect_eq "$CODE" 0 "exit code"
    expect_grep "An absolute path without spaces or a colon is needed" "$OUT" "path asked again"
    expect_grep "has to be a number between 1 and 65535" "$OUT" "port asked again"
    expect_grep "Dockge2 is running" "$OUT" "finished"
    expect_eq "$(sed -n 's/^DOCKGE_PORT=//p' "$WORK/s14/.env")" "$PORT" ".env port"
}

scenario_published_image_is_downloaded_instead_of_built() {
    # What a small server needs: the build is the part that wants a gigabyte,
    # and a published image removes it from the install entirely
    rm -f "$WORK/pulled"
    STUB_HAS_IMAGE=0 STUB_PULL_OK=1 run "$INSTALLER" --yes --port "$PORT" --dir "$WORK/s15" --stacks-dir "$WORK/stacks"
    expect_eq "$CODE" 0 "exit code"
    expect_grep "Looking for a published image" "$OUT" "the search is announced"
    expect_grep "ghcr.io/mazixs/dockge2:latest" "$STUB_LOG" "pulled the default image"
    expect_no_grep "compose -f docker-compose.yml build" "$STUB_LOG" "nothing was built"
    expect_eq "$(sed -n 's/^DOCKGE_IMAGE=//p' "$WORK/s15/.env")" "ghcr.io/mazixs/dockge2:latest" ".env points at the pulled image"
    expect_grep "Dockge2 is running" "$OUT" "finished"
}

scenario_missing_published_image_falls_back_to_building() {
    # Today there is no published image at all, so this is the path every
    # install takes: say it plainly and build instead of stopping
    STUB_HAS_IMAGE=0 run "$INSTALLER" --yes --port "$PORT" --dir "$WORK/s16" --stacks-dir "$WORK/stacks"
    expect_eq "$CODE" 0 "exit code"
    expect_grep "There is none to download" "$OUT" "says why it builds"
    expect_grep "compose -f docker-compose.yml build" "$STUB_LOG" "built instead"
    expect_grep "Dockge2 is running" "$OUT" "finished"
}

scenario_build_option_ignores_a_published_image() {
    # --build is how a branch gets installed: a release image would be the
    # wrong code, however available it is
    rm -f "$WORK/pulled"
    STUB_HAS_IMAGE=0 STUB_PULL_OK=1 run "$INSTALLER" --yes --build --port "$PORT" --dir "$WORK/s17" --stacks-dir "$WORK/stacks"
    expect_eq "$CODE" 0 "exit code"
    expect_no_grep "docker pull" "$STUB_LOG" "the registry was not asked"
    expect_grep "compose -f docker-compose.yml build" "$STUB_LOG" "built from the sources"
}

scenario_named_image_that_cannot_be_pulled_stops() {
    # An image named by hand is an instruction. Quietly building something else
    # would install code the user did not ask for
    STUB_HAS_IMAGE=0 STUB_PULL_OK=0 run "$INSTALLER" --yes --image ghcr.io/mazixs/dockge2:v9.9.9 \
        --port "$PORT" --dir "$WORK/s18" --stacks-dir "$WORK/stacks"
    expect_eq "$CODE" 1 "stops"
    expect_grep "cannot be downloaded" "$OUT" "says what failed"
    expect_no_grep "compose -f docker-compose.yml build" "$STUB_LOG" "did not build instead"
}

########################################
# Run
########################################
SCENARIOS="$(declare -F | awk '{print $3}' | grep '^scenario_')"
if [ "$#" -gt 0 ]; then SCENARIOS="$*"; fi
for CURRENT in $SCENARIOS; do
    printf '%s\n' "$CURRENT"
    "$CURRENT"
done
printf '\n%d checks passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" = "0" ]
