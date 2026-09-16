/** Validate a Git address without allowing credentials or local file sources.
 * @param repository User-provided address
 * @returns Whether it can be shown and sent without exposing embedded credentials
 */
export function isSafeGitRepository(repository: string): boolean {
    const address = repository.trim();
    if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s?#]+$/.test(address)) {
        return true;
    }
    try {
        const url = new URL(address);
        return [ "https:", "http:", "ssh:" ].includes(url.protocol) && Boolean(url.hostname)
            && url.pathname.length > 1 && !url.password && !url.search && !url.hash
            && (url.protocol === "ssh:" || !url.username);
    } catch {
        return false;
    }
}

/** Require a reviewed choice for each file, including hidden files.
 * @param files Changed preview files
 * @param choices Explicit user decisions
 * @returns Whether the complete result may be submitted
 */
export function canApplyGitChoices(files: Array<{path: string; redacted?: boolean; binary?: boolean}>, choices: Record<string, string>, edited: Record<string, string> = {}): boolean {
    return files.length > 0 && files.every(file => Object.hasOwn(choices, file.path)
        && ([ "server", "git" ].includes(choices[file.path] || "") || (choices[file.path] === "edited" && !file.redacted && !file.binary && Object.hasOwn(edited, file.path) && typeof edited[file.path] === "string")));
}

/** Compare complete lines while preserving the exact original text for rendering.
 * Uses line alignment for separate hunks. Very large comparisons fall back to
 * a changed block between the shared prefix/suffix, keeping memory bounded.
 * @param source This side of the comparison; null means absent or withheld
 * @param other Other side of the comparison
 * @returns Display rows with change markers
 */
export function diffLineRows(source: string | null, other: string | null): Array<{text: string; changed: boolean}> {
    if (source === null) {
        return [];
    }
    const lines = source.split("\n");
    const opposite = other?.split("\n") || [];
    let start = 0;
    while (start < Math.min(lines.length, opposite.length) && lines[start] === opposite[start]) {
        start++;
    }
    let end = lines.length;
    let otherEnd = opposite.length;
    while (end > start && otherEnd > start && lines[end - 1] === opposite[otherEnd - 1]) {
        end--;
        otherEnd--;
    }
    const unchanged = new Set<number>();
    const rows = end - start;
    const columns = otherEnd - start;
    if (rows > 0 && columns > 0 && (rows + 1) * (columns + 1) <= 250_000) {
        const stride = columns + 1;
        const lengths = new Uint32Array((rows + 1) * stride);
        for (let row = rows - 1; row >= 0; row--) {
            for (let column = columns - 1; column >= 0; column--) {
                lengths[row * stride + column] = lines[start + row] === opposite[start + column]
                    ? 1 + (lengths[(row + 1) * stride + column + 1] || 0)
                    : Math.max(lengths[(row + 1) * stride + column] || 0, lengths[row * stride + column + 1] || 0);
            }
        }
        let row = 0;
        let column = 0;
        while (row < rows && column < columns) {
            if (lines[start + row] === opposite[start + column]) {
                unchanged.add(start + row);
                row++;
                column++;
            } else if ((lengths[(row + 1) * stride + column] || 0) >= (lengths[row * stride + column + 1] || 0)) {
                row++;
            } else {
                column++;
            }
        }
    }
    return lines.map((text, index) => ({ text,
        changed: index >= start && index < end && !unchanged.has(index) }));
}
