import { log } from "./log";
import compareVersions from "compare-versions";
import packageJSON from "../package.json";
import { Settings } from "./settings";

// How much time in ms to wait between update checks
const UPDATE_CHECKER_INTERVAL_MS = 1000 * 60 * 60 * 48;

// Релизы этого форка, а не upstream: чужой номер версии подсказывал бы
// обновление, которого для этой панели не существует. Запрос уходит только
// когда владелец включил проверку - по умолчанию она выключена, и установка
// не сообщает о себе никому
const CHECK_URL = "https://api.github.com/repos/mazixs/dockge2/releases?per_page=20";

// Сколько ждать ответа реестра. `fetch` сам по себе не сдается: запрос к машине,
// которая приняла соединение и молчит, висит столько, сколько позволит система, и
// держит за собой остановку процесса
const CHECK_TIMEOUT_MS = 1000 * 10;

interface Release {
    tag_name? : unknown;
    draft? : unknown;
    prerelease? : unknown;
}

class CheckVersion {
    version = packageJSON.version;

    // Not an optional property but one that is always there and may hold nothing: the
    // difference is what lets "the registry was never asked" be written back
    latestVersion : string | undefined;
    interval : NodeJS.Timeout | undefined;

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

            const version = release.tag_name.replace(/^v/, "");

            if (!compareVersions.validate(version)) {
                continue;
            }

            const key = release.prerelease === true ? "beta" : "stable";
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
     * Ask the registry once for the releases it has.
     *
     * Separate from the interval so that turning the check on can answer immediately:
     * the interval is two days long, and a switch that shows nothing until the next
     * restart reads as a switch that does not work.
     * @returns {Promise<void>}
     */
    async check() : Promise<void> {
        // Проверка обновлений - исходящий запрос к третьей стороне, поэтому
        // она делается только по явному согласию владельца
        if (this.stopped || await Settings.get("checkUpdate") !== true) {
            return;
        }

        // The state is read again, because reading the setting is itself a wait. A stop
        // landing inside it found no controller to abort - it did not exist yet - and the
        // request left afterwards, from a panel that had already reported the network
        // released. The first check stays: it keeps the settings read out of a stopped panel
        if (this.stopped) {
            return;
        }

        log.debug("update-checker", "Retrieving latest versions");

        const controller = new AbortController();
        this.controller = controller;

        // Срок жизни запроса принадлежит панели, а не сети: по нему же его обрывает
        // остановка процесса, и обе причины выглядят одинаково - проверка не удалась
        const deadline = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

        try {
            const res = await fetch(CHECK_URL, { headers: { "accept": "application/vnd.github+json" },
                signal: controller.signal });
            const { stable, beta } = this.parseReleases(await res.json());

            // The answer can arrive just as the panel stops, and what follows reads a
            // setting - that is the database, which is being released at that moment
            if (this.stopped) {
                return;
            }

            // For debug
            const slow = process.env.TEST_CHECK_VERSION === "1" ? "1000.0.0" : stable;

            if (await Settings.get("checkBeta") && beta && (!slow || compareVersions.compare(beta, slow, ">"))) {
                this.latestVersion = beta;
                return;
            }

            if (slow) {
                this.latestVersion = slow;
            }

        } catch {
            log.info("update-checker", "Failed to check for new versions");
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
     * @returns {Promise<void>}
     */
    async startInterval() : Promise<void> {
        if (this.stopped) {
            return;
        }

        await this.check();

        if (this.stopped) {
            return;
        }

        this.interval = setInterval(() => {
            void this.check();
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
