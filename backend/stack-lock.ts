import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Directories the running operation already holds.
 *
 * A write path may call another one - saving a stack writes files, binding a secret
 * rewrites the compose file - and a second attempt to take the same lock would wait for
 * an operation that can only finish after it. Nesting is therefore allowed inside one
 * operation and only between operations does the queue apply.
 */
const held = new AsyncLocalStorage<Set<string>>();

/**
 * One queue per stack directory, shared by every write path.
 *
 * The browser editor, the Git workflow and MCP all write the same files, so a lock that
 * only one of them takes proves nothing. The key is the resolved directory, because that
 * is what the filesystem sees: two stack names can never map onto one directory, but the
 * same directory can be reached through different callers.
 */
const queues : Map<string, Promise<unknown>> = new Map();

/**
 * Resolve the directory the way the lock keys it.
 * @param dir Stack directory, absolute or relative
 * @returns Key of the queue
 */
function lockKey(dir : string) : string {
    return path.resolve(dir);
}

/**
 * Whether some other operation currently holds or waits for this directory.
 * @param dir Stack directory
 * @returns True when an operation is queued
 */
export function stackLockBusy(dir : string) : boolean {
    return queues.has(lockKey(dir));
}

/**
 * Run an operation while no other write path touches the same stack directory.
 *
 * Callers that cannot wait ask stackLockBusy() first and report their own refusal: the
 * lock itself never invents a message, because what "busy" means differs per transport.
 * @param dir Stack directory
 * @param operation Work to run exclusively
 * @returns Whatever the operation returns
 */
export async function withStackLock<T>(dir : string, operation : () => Promise<T>) : Promise<T> {
    const key = lockKey(dir);
    const owned = held.getStore();

    if (owned?.has(key)) {
        return operation();
    }

    const previous = queues.get(key) ?? Promise.resolve();

    let release : () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });

    // The chain is registered synchronously, so a caller checking stackLockBusy() right
    // after this line already sees the directory as taken
    const chained = previous.then(() => current, () => current);
    queues.set(key, chained);

    await previous.catch(() => undefined);

    const nested = new Set(owned ?? []);
    nested.add(key);

    try {
        return await held.run(nested, operation);
    } finally {
        release();
        // Only the last link clears the entry: an earlier one would let a waiting caller
        // believe the directory is free while it still runs
        if (queues.get(key) === chained) {
            queues.delete(key);
        }
    }
}
