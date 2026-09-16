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

interface Release {
    tag_name? : unknown;
    draft? : unknown;
    prerelease? : unknown;
}

class CheckVersion {
    version = packageJSON.version;
    latestVersion? : string;
    interval? : NodeJS.Timeout;

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

    async startInterval() {
        const check = async () => {
            // Проверка обновлений - исходящий запрос к третьей стороне, поэтому
            // она делается только по явному согласию владельца
            if (await Settings.get("checkUpdate") !== true) {
                return;
            }

            log.debug("update-checker", "Retrieving latest versions");

            try {
                const res = await fetch(CHECK_URL, { headers: { "accept": "application/vnd.github+json" } });
                const { stable, beta } = this.parseReleases(await res.json());

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
            }

        };

        await check();
        this.interval = setInterval(check, UPDATE_CHECKER_INTERVAL_MS);
    }
}

const checkVersion = new CheckVersion();
export default checkVersion;
