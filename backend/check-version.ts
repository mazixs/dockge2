import { UPDATE_CHECK_MESSAGES, type UpdateCheckError } from "../common/update-check";
import { log } from "./log";
import { runInBackground } from "./background";
import compareVersions from "compare-versions";
import packageJSON from "../package.json";
import { Settings } from "./settings";

// How much time in ms to wait between update checks
const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 48;

// Релизы этого форка, а не upstream: чужой номер версии подсказывал бы
// обновление, которого для этой панели не существует. Запрос уходит только
// когда владелец включил проверку - по умолчанию она выключена, и установка
// не сообщает о себе никому
const CHECK_URL = "https://api.github.com/repos/mazixs/dockge2/releases?per_page=100";

// Сколько ждать ответа реестра. `fetch` сам по себе не сдается: запрос к машине,
// которая приняла соединение и молчит, висит столько, сколько позволит система, и
// держит за собой остановку процесса
const CHECK_TIMEOUT_MS = 1000 * 10;

interface Release {
    tag_name? : unknown;
    draft? : unknown;
    prerelease? : unknown;
    assets? : { name? : unknown, state? : unknown }[];
}

export type UpdateCheckResult = { ok: true; latestVersion: string; updateAvailable: boolean } | { ok: false; code: UpdateCheckError; msg: string; msgi18n: true };

/** Classify only documented HTTP signals, never a message scraped from the response body.
 * @param response GitHub response
 * @returns Safe failure category
 */
function registryFailure(response : Response) : UpdateCheckError {
    const limited = response.status === 429 || (response.status === 403 && (response.headers?.get("x-ratelimit-remaining") === "0" || response.headers?.has("retry-after")));
    return limited ? "rateLimited" : "registry";
}

class CheckVersion {
    version = packageJSON.version;

    // Not an optional property but one that is always there and may hold nothing: the
    // difference is what lets "the registry was never asked" be written back
    latestVersion : string | undefined;
    interval : NodeJS.Timeout | undefined;
    lastCheckedAt : string | undefined;
    checkFailed = false;
    checkError : UpdateCheckError | undefined;
    private inFlight : Promise<UpdateCheckResult | undefined> | undefined;

    /**
     * Whether this checker is allowed to own anything at the moment.
     *
     * `startInterval` waits for a request before it creates its timer, and the process
     * can be told to shut down inside that wait. Without this the stopped checker
     * registered a fresh interval afterwards: the shutdown reported the resource as
     * released while it was in fact created a moment later.
     */
    private stopped = false;

    /** Cancels the request that is in flight, so a stop reaches the network too */
    private controller : AbortController | undefined;

    /**
     * Разобрать ответ реестра релизов в наибольшую стабильную и наибольшую бета-версию
     * @param {unknown} payload Тело ответа
     * @returns {{ stable?: string, beta?: string }} Найденные версии
     */
    parseReleases(payload : unknown) : { stable? : string, beta? : string } {
        if (!Array.isArray(payload)) {
            return {};
        }

        const result : { stable? : string, beta? : string } = {};

        for (const release of payload as Release[]) {
            if (release?.draft === true || typeof release?.tag_name !== "string") {
                continue;
            }

            const assets = new Set(Array.isArray(release.assets) ? release.assets.filter(asset => asset.state === "uploaded").map(asset => asset.name) : []);
            if (![ "release.json", "release.json.sigstore.json", "docker-compose.yml", "install.sh", "dockge2-update-linux-amd64", "dockge2-update-linux-arm64", "dockge2-update-linux-amd64.sigstore.json", "dockge2-update-linux-arm64.sigstore.json" ].every(name => assets.has(name))) {
                continue;
            }
            const version = release.tag_name.replace(/^v/, "");

            if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version) || !compareVersions.validate(version)) {
                continue;
            }

            const key = release.prerelease === true || version.includes("-") ? "beta" : "stable";
            const known = result[key];

            if (!known || compareVersions.compare(version, known, ">")) {
                result[key] = version;
            }
        }

        return result;
    }

    /**
     * Is the release that was found newer than the one running here?
     *
     * The registry is asked for the newest release there is, which is the same as the
     * one running here most of the time and older than it on a deployment that was
     * rolled back. Only a newer one is news.
     * @returns {boolean} True when an update exists
     */
    get updateAvailable() : boolean {
        if (!this.latestVersion || !compareVersions.validate(this.latestVersion)) {
            return false;
        }

        return compareVersions.compare(this.latestVersion, this.version, ">");
    }

    /**
     * Check once. An explicit owner request does not enable future background requests.
     * Concurrent callers share one request to avoid multiplying GitHub API traffic.
     * @param manual Whether the owner explicitly requested this check
     * @returns A fresh result, or no result when background checking is disabled or stopped
     */
    async check(manual = false) : Promise<UpdateCheckResult | undefined> {
        if (this.stopped || (!manual && await Settings.get("checkUpdate") !== true)) {
            return;
        }
        // Shutdown can happen while the preference is being read.
        if (this.stopped) {
            return;
        }
        if (this.inFlight) {
            return this.inFlight;
        }
        this.inFlight = this.fetchRelease();
        try {
            return await this.inFlight;
        } finally {
            this.inFlight = undefined;
        }
    }

    /** Fetch and validate a fresh release list without changing stored preferences. */
    private async fetchRelease() : Promise<UpdateCheckResult | undefined> {
        log.debug("update-checker", "Retrieving latest versions");

        const controller = new AbortController();
        this.controller = controller;

        // Срок жизни запроса принадлежит панели, а не сети: по нему же его обрывает
        // остановка процесса, и обе причины выглядят одинаково - проверка не удалась
        let timedOut = false;
        let failure : UpdateCheckError = "network";
        const deadline = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, CHECK_TIMEOUT_MS);

        try {
            const payload : unknown[] = [];
            for (let page = 1; page <= 10; page++) {
                failure = "network";
                const res = await fetch(`${CHECK_URL}&page=${page}`, { headers: { "accept": "application/vnd.github+json" },
                    signal: controller.signal });
                if (!res.ok) {
                    failure = registryFailure(res);
                    throw new Error("Release registry request failed");
                }
                failure = "invalidResponse";
                const releases : unknown = await res.json();
                if (!Array.isArray(releases)) {
                    throw new Error("Invalid release list");
                }
                payload.push(...releases);
                if (releases.length < 100) {
                    break;
                }
                if (page === 10) {
                    throw new Error("Release pagination limit reached");
                }
            }
            const { stable, beta } = this.parseReleases(payload);

            // The answer can arrive just as the panel stops, and what follows reads a
            // setting - that is the database, which is being released at that moment
            if (this.stopped) {
                return;
            }

            failure = "internal";

            const includeBeta = await Settings.get("checkBeta") === true;
            if (this.stopped) {
                return;
            }
            const latest = includeBeta && beta && (!stable || compareVersions.compare(beta, stable, ">")) ? beta : stable;
            if (!latest) {
                failure = "noRelease";
                throw new Error("Release registry returned no matching releases");
            }
            this.latestVersion = latest;
            this.lastCheckedAt = new Date().toISOString();
            this.checkFailed = false;
            this.checkError = undefined;
            return { ok: true,
                latestVersion: latest,
                updateAvailable: this.updateAvailable };

        } catch {
            if (this.stopped) {
                return;
            }
            this.checkFailed = true;
            this.checkError = timedOut ? "timeout" : failure;
            log.info("update-checker", "Failed to check for new versions");
            return { ok: false,
                code: this.checkError,
                msg: UPDATE_CHECK_MESSAGES[this.checkError],
                msgi18n: true };
        } finally {
            clearTimeout(deadline);

            if (this.controller === controller) {
                this.controller = undefined;
            }
        }
    }

    /**
     * Ask once and then keep asking every two days.
     *
     * The first request is awaited, so the state after a stop is checked again before the
     * timer is created: a checker that was stopped during that request owns nothing
     * afterwards.
     * @param onChecked Notify connected browsers after a successful check
     * @returns {Promise<void>}
     */
    async startInterval(onChecked : () => Promise<void> = async () => {}) : Promise<void> {
        if (this.stopped) {
            return;
        }

        const result = await this.check();

        if (this.stopped) {
            return;
        }

        if (result) {
            await onChecked().catch(error => log.error("update-checker", error));
        }
        if (this.stopped) {
            return;
        }
        this.interval = setInterval(() => {
            runInBackground("version check", async () => {
                const next = await this.check();
                if (next && !this.stopped) {
                    await onChecked();
                }
            });
        }, UPDATE_CHECKER_INTERVAL_MS);
    }

    /**
     * Остановить периодическую проверку.
     *
     * Вызывается при остановке процесса: интервал, переживший закрытие базы, обращается
     * к настройкам, которых уже нет.
     * @returns {void}
     */
    stopInterval() : void {
        this.stopped = true;
        this.controller?.abort();
        this.controller = undefined;

        if (this.interval) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }

    /**
     * Let this checker own things again.
     *
     * Only the tests need it: one process starts the checker once and stops it when it
     * exits, but the tests start and stop the same instance many times over.
     * @returns {void}
     */
    resume() : void {
        this.stopped = false;
    }
}

const checkVersion = new CheckVersion();
export default checkVersion;
