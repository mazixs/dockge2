import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "./child-process";
import { StackGitError } from "./stack-git";
import { gitRepositoryProblem, isSshRepository } from "../common/git-repository";
import type { GitDeployKey } from "../common/types/stack-git";

/**
 * SSH keys the panel creates for private repositories, one per repository.
 *
 * A deploy key belongs to one repository on GitHub, GitLab and Bitbucket, so the key is
 * found by the address rather than by the stack: the address is known before the stack
 * has a name, and two stacks of one repository need the same key. The private half never
 * leaves the data directory; only the public line and its fingerprint are reported.
 */
export class GitDeployKeys {
    /**
     * @param dir Directory of the keys, inside the panel's data directory
     */
    constructor(private readonly dir : string) {}

    /**
     * File of the private key for an address, whether or not it exists.
     * @param repository Repository address
     * @returns Absolute path
     * @throws {StackGitError} When the address is not an SSH address the panel accepts
     */
    private file(repository : string) : string {
        if (gitRepositoryProblem(repository) !== null || !isSshRepository(repository)) {
            throw new StackGitError("gitDeployKeyNeedsSsh");
        }
        return path.join(this.dir, createHash("sha256").update(repositoryIdentity(repository)).digest("hex").slice(0, 32));
    }

    /**
     * Private key to connect with, when one was created for the address.
     * @param repository Repository address
     * @returns Path of the key, or undefined for an HTTP address or one without a key
     */
    async keyFile(repository : string) : Promise<string | undefined> {
        if (gitRepositoryProblem(repository) !== null || !isSshRepository(repository)) {
            return undefined;
        }
        const file = this.file(repository);
        try {
            const stat = await fs.lstat(file);
            return stat.isFile() ? file : undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * The public half of the key for an address.
     * @param repository Repository address
     * @returns The key, or null when none was created
     */
    async get(repository : string) : Promise<GitDeployKey | null> {
        const file = this.file(repository);
        let line : string;
        try {
            const handle = await fs.open(`${file}.pub`, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                line = (await handle.readFile("utf-8")).trim();
            } finally {
                await handle.close();
            }
        } catch {
            return null;
        }
        return publicKey(line);
    }

    /**
     * Create the key for an address, or return the one already there.
     *
     * An existing key is never replaced: the repository already trusts it, and a new one
     * would lock the stack out until someone adds it again.
     * @param repository Repository address
     * @returns The public half
     */
    async create(repository : string) : Promise<GitDeployKey> {
        const existing = await this.get(repository);
        if (existing) {
            return existing;
        }
        const file = this.file(repository);
        await fs.mkdir(this.dir, { recursive: true,
            mode: 0o700 });
        await fs.chmod(this.dir, 0o700);
        // Written beside the target and renamed, so a key is either complete or absent
        const stage = path.join(this.dir, `.${randomUUID()}`);
        try {
            await spawn("ssh-keygen", [ "-q", "-t", "ed25519", "-N", "", "-C", "dockge2", "-f", stage ], { timeoutMs: 30_000 });
            await fs.chmod(stage, 0o600);
            await fs.rename(stage, file);
            await fs.rename(`${stage}.pub`, `${file}.pub`);
        } catch {
            throw new StackGitError("gitDeployKeyFailed");
        } finally {
            await fs.rm(stage, { force: true });
            await fs.rm(`${stage}.pub`, { force: true });
        }
        const created = await this.get(repository);
        if (!created) {
            throw new StackGitError("gitDeployKeyFailed");
        }
        return created;
    }
}

/**
 * One address however it was typed: the host and path, without a trailing slash or `.git`.
 * @param repository Repository address
 * @returns What the key is found by
 */
export function repositoryIdentity(repository : string) : string {
    return repository.trim().replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * Read the public line `ssh-keygen` wrote.
 * @param line Contents of the `.pub` file
 * @returns The key with its fingerprint, as `ssh-keygen -l` prints it
 * @throws {StackGitError} When the file is not an ed25519 public key
 */
export function publicKey(line : string) : GitDeployKey {
    const match = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})(?: .*)?$/.exec(line);
    if (!match) {
        throw new StackGitError("gitDeployKeyFailed");
    }
    const blob = Buffer.from(match[2]!, "base64");
    return { publicKey: `${match[1]} ${match[2]} dockge2`,
        fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
}
