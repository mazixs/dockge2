// Правило адреса общее с сервером: кнопка включена ровно тогда, когда сервер
// адрес примет. Реэкспорт, а не своя копия - копия уже расходилась с сервером
export { isSafeGitRepository, stackNameFromRepository } from "../../common/git-repository";

/** Require a reviewed choice for each file, including hidden files.
 * @param files Changed preview files
 * @param choices Explicit user decisions
 * @returns Whether the complete result may be submitted
 */
export function canApplyGitChoices(files: Array<{path: string; redacted?: boolean; binary?: boolean}>, choices: Record<string, string>, edited: Record<string, string> = {}): boolean {
    return files.length > 0 && files.every(file => Object.hasOwn(choices, file.path)
        && ([ "server", "git" ].includes(choices[file.path] || "") || (choices[file.path] === "edited" && !file.redacted && !file.binary && Object.hasOwn(edited, file.path) && typeof edited[file.path] === "string")));
}

/** Find the lines of a changed block that appear on both sides.
 * The block is aligned with a longest common subsequence. A very large block is
 * left unaligned instead, so a huge file cannot cost unbounded memory.
 * @param lines This side of the comparison
 * @param opposite Other side of the comparison
 * @param start First line the two sides differ at
 * @param rows How many lines of this side the changed block has
 * @param columns How many lines of the other side the changed block has
 * @returns Indexes of this side that also exist on the other side
 */
function matchedLines(lines: string[], opposite: string[], start: number, rows: number, columns: number): Set<number> {
    const unchanged = new Set<number>();
    if (rows <= 0 || columns <= 0 || (rows + 1) * (columns + 1) > 250_000) {
        return unchanged;
    }
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
    return unchanged;
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
    const unchanged = matchedLines(lines, opposite, start, end - start, otherEnd - start);
    return lines.map((text, index) => ({ text,
        changed: index >= start && index < end && !unchanged.has(index) }));
}
