/**
 * Preserve equal JSON subtrees from an authoritative replacement snapshot.
 * Missing fields are removed; no response, permission or mutable value is cached.
 * @param previous Last snapshot
 * @param next Fresh JSON value, which is safe to take ownership of
 * @returns Fresh value with unchanged subtree identities
 */
export function reconcileSnapshot<T>(previous : T, next : T) : T {
    if (Object.is(previous, next)) {
        return previous;
    }
    if (!previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) !== Array.isArray(next)) {
        return next;
    }
    const before = previous as Record<string, unknown>;
    const after = next as Record<string, unknown>;
    const keys = Object.keys(after);
    let equal = keys.length === Object.keys(before).length;
    for (const key of keys) {
        const owns = Object.hasOwn(before, key);
        const value = owns ? reconcileSnapshot(before[key], after[key]) : after[key];
        if (!owns || value !== before[key]) {
            equal = false;
        }
        after[key] = value;
    }
    return equal ? previous : next;
}
