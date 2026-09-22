/** Map independent reads with bounded concurrency and stable result ordering. */
export async function mapConcurrent<T, R>(values : readonly T[], concurrency : number, read : (value : T) => Promise<R>) : Promise<R[]> {
    const result : R[] = new Array(values.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
        while (next < values.length) {
            const index = next++;
            result[index] = await read(values[index]!);
        }
    }));
    return result;
}
