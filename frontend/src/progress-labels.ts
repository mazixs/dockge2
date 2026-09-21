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

/**
 * Verb forms that depend on the kind of resource.
 *
 * "Created" is one word in English and three in a language that inflects: the panel
 * writes a whole sentence - kind, name, verb - so the verb has to agree with the noun
 * in front of it. Only the finished states need this; a resource that is still being
 * created is described the same way whatever it is.
 */
export const VERB_KIND_KEYS : Record<string, Record<string, string>> = {
    network: {
        created: "progressVerbCreatedNetwork",
        started: "progressVerbStartedNetwork",
        stopped: "progressVerbStoppedNetwork",
        removed: "progressVerbRemovedNetwork",
        pulled: "progressVerbPulledNetwork",
        built: "progressVerbBuiltNetwork",
        skipped: "progressVerbSkippedNetwork",
    },
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
