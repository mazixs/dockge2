import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A line of the report as a fixture records it */
export interface FixtureReportItem {
    flag : string;
    reason : string;
}

/**
 * One case of the `docker run` corpus in `test/fixtures/docker-run/`.
 *
 * A fixture records what the converter really does today, losses included: an
 * expectation that hid a loss would make the corpus useless as a reason to keep
 * or replace the converter.
 */
export interface DockerRunFixture {
    /** File name without the extension */
    name : string;

    /** What the case is about and what the converter does with it */
    description : string;

    /** Command as a person pastes it */
    command : string;

    /**
     * `kept`: every flag carried; `warned`: carried, but something needs a look;
     * `lost`: something the command asked for is not in the file, and the report says so
     */
    verdict : "kept" | "warned" | "lost";

    compose : {
        /** Exact top level keys: anything else, such as `version`, was added */
        topLevel : string[];

        /** Name of the one service, taken from the image */
        service : string;

        /** Exact keys of that service: anything else was added without being asked */
        keys : string[];

        /** Values that must survive, by service key */
        values : Record<string, unknown>;

        /** Values that must survive, by top level key */
        topLevelValues? : Record<string, unknown>;

        /** Text that must be in the output, for what parsing hides, such as the quotes around `no` */
        text? : string[];
    };

    /** The report, flag by flag, in the order the command wrote them */
    report : {
        carried : string[];
        review : FixtureReportItem[];
        dropped : FixtureReportItem[];
    };

    /** What `docker compose config --quiet` says about the output */
    composeConfig : {
        valid : boolean;

        /** Regular expression its error output must match */
        stderr? : string;

        /** Files the compose file refers to, created next to it before the check */
        files? : Record<string, string>;
    };
}

/** Directory of the corpus */
export const corpusDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "docker-run");

/**
 * Read every fixture of the corpus, in file name order
 * @returns Fixtures with their names
 */
export function loadDockerRunCorpus() : DockerRunFixture[] {
    return readdirSync(corpusDir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => ({
            ...JSON.parse(readFileSync(path.join(corpusDir, file), "utf8")) as Omit<DockerRunFixture, "name">,
            name: file.slice(0, -".json".length),
        }));
}
