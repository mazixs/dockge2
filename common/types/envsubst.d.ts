declare module "@inventage/envsubst" {
    export function replaceVariablesSync(
        value: string,
        variables?: Record<string, string | undefined>,
        prefix?: string,
        trimWindow?: boolean,
        ignoreCase?: boolean,
    ): [string, Array<{ from: string; to: string; count: number }>];
}
