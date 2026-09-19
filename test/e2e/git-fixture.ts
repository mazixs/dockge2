import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "../../backend/child-process";

/**
 * A repository the panel can actually clone from, served next to the e2e run.
 *
 * The server refuses a local path as a remote, and rightly so: a socket must not be able to
 * name a directory of the machine. So the fixture is published over HTTP, the same transport
 * a user gives the panel, and the run needs no network and no account anywhere.
 *
 * The transport is the dumb one: a static file server over a bare repository. It is enough
 * for clone and fetch, and it keeps the fixture to files on disk.
 */

/** Root of the fixture, outside the directories the seed wipes */
export const GIT_FIXTURE_DIR = process.env.DOCKGE_E2E_GIT_DIR ?? "/tmp/dockge-e2e/git";

/** The bare repository the panel talks to */
const ORIGIN_DIR = path.join(GIT_FIXTURE_DIR, "origin.git");

/** The work tree the test commits into before pushing */
const WORK_DIR = path.join(GIT_FIXTURE_DIR, "work");

/**
 * Run git with an identity of its own.
 * The run must not depend on the machine's global configuration, and it must not try to sign.
 * @param cwd Directory to run in
 * @param args Git arguments
 * @returns void
 */
async function git(cwd : string, args : string[]) : Promise<void> {
    await spawn("git", [
        "-c", "user.name=Dockge E2E",
        "-c", "user.email=e2e@example.com",
        "-c", "commit.gpgsign=false",
        ...args,
    ], {
        cwd,
        encoding: "utf-8",
        timeoutMs: 60_000,
    });
}

/**
 * Create the fixture repository with its first commit.
 * @param branch Branch the panel will be pointed at
 * @param files File contents of the first commit, by name
 * @returns void
 */
export async function prepareGitFixture(branch : string, files : Record<string, string>) : Promise<void> {
    await rm(GIT_FIXTURE_DIR, { recursive: true,
        force: true });
    await mkdir(ORIGIN_DIR, { recursive: true });
    await mkdir(WORK_DIR, { recursive: true });

    await git(ORIGIN_DIR, [ "init", "--bare", `--initial-branch=${branch}`, "." ]);
    // The dumb transport reads static files, and only this hook refreshes them.
    // Without it a push would land in the repository and stay invisible over HTTP.
    await writeFile(path.join(ORIGIN_DIR, "hooks/post-update"), "#!/bin/sh\nexec git update-server-info\n", { mode: 0o755 });

    await git(WORK_DIR, [ "init", `--initial-branch=${branch}`, "." ]);
    await git(WORK_DIR, [ "remote", "add", "origin", ORIGIN_DIR ]);
    await commitGitFixture(branch, files, "first");
}

/**
 * Add a commit to the fixture and publish it.
 * @param branch Branch to push
 * @param files File contents to write before committing, by name
 * @param message Commit message
 * @returns void
 */
export async function commitGitFixture(branch : string, files : Record<string, string>, message : string) : Promise<void> {
    for (const [ name, content ] of Object.entries(files)) {
        await writeFile(path.join(WORK_DIR, name), content);
    }

    await git(WORK_DIR, [ "add", "-A" ]);
    await git(WORK_DIR, [ "commit", "-m", message ]);
    await git(WORK_DIR, [ "push", "origin", branch ]);
}

/**
 * Serve the fixture over HTTP on the loopback address.
 *
 * Read only, loopback only and without a directory listing: the fixture is a test
 * artefact, not something the machine should offer to the network.
 * @param port Port to listen on
 * @returns The listening server, to be closed by the caller
 */
export function serveGitFixture(port : number) : Promise<http.Server> {
    const server = http.createServer((request, response) => {
        void (async () => {
            const requested = new URL(request.url ?? "/", "http://127.0.0.1");
            const file = path.join(GIT_FIXTURE_DIR, path.normalize(decodeURIComponent(requested.pathname)));

            if ((request.method !== "GET" && request.method !== "HEAD") || !file.startsWith(GIT_FIXTURE_DIR + path.sep)) {
                response.writeHead(403).end();
                return;
            }

            try {
                const info = await stat(file);

                if (!info.isFile()) {
                    throw new Error("not a file");
                }

                response.writeHead(200, { "content-type": "application/octet-stream",
                    "content-length": info.size });

                if (request.method === "HEAD") {
                    response.end();
                    return;
                }

                createReadStream(file).pipe(response);
            } catch {
                response.writeHead(404).end();
            }
        })();
    });

    return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve(server));
    });
}

/**
 * Stop the fixture server without waiting for idle connections.
 * @param server Server returned by serveGitFixture
 * @returns void
 */
export function stopGitFixture(server : http.Server) : Promise<void> {
    return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
    });
}
