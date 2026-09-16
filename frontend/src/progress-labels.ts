/**
 * Слова и значки для хода команды.
 *
 * Живут отдельно от панели: теми же словами таблица сервисов называет
 * состояние, пока команда идет, - "запускается" вместо "работает".
 */

/**
 * Как назвать команду словом. Действие над одним сервисом называется тем же
 * словом, что и над стеком: чей это вывод, видно в самих шагах
 */
export const COMMAND_KEYS : Record<string, string> = {
    startStack: "progressRunStart",
    stopStack: "progressRunStop",
    restartStack: "progressRunRestart",
    updateStack: "progressRunUpdate",
    downStack: "progressRunDown",
    deployStack: "progressRunDeploy",
    startService: "progressRunStart",
    stopService: "progressRunStop",
    restartService: "progressRunRestart",
};

/** Глагол compose словами интерфейса */
export const VERB_KEYS : Record<string, string> = {
    creating: "progressVerbCreating",
    created: "progressVerbCreated",
    starting: "progressVerbStarting",
    started: "progressVerbStarted",
    stopping: "progressVerbStopping",
    stopped: "progressVerbStopped",
    removing: "progressVerbRemoving",
    removed: "progressVerbRemoved",
    pulling: "progressVerbPulling",
    pulled: "progressVerbPulled",
    building: "progressVerbBuilding",
    built: "progressVerbBuilt",
    waiting: "progressVerbWaiting",
    healthy: "progressVerbHealthy",
    running: "progressVerbRunning",
    exists: "progressVerbExists",
    skipped: "progressVerbSkipped",
    error: "progressVerbError",
};

export const KIND_KEYS : Record<string, string> = {
    container: "progressKindContainer",
    network: "progressKindNetwork",
    volume: "progressKindVolume",
    image: "progressKindImage",
};

/** Вид ресурса значком: контейнер рисуется тем же кубом, что и в таблице сервисов */
export const KIND_ICONS : Record<string, string> = {
    container: "box",
    network: "network",
    volume: "volume",
    image: "image",
};
