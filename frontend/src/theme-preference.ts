export type ThemePreference = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Treat missing or obsolete preferences as a request to follow the system. */
export function normaliseTheme(value : unknown) : ThemePreference {
    return value === "light" || value === "dark" ? value : "auto";
}

/** Resolve a preference without losing the user's choice of system mode. */
export function resolveTheme(preference : unknown, systemDark : boolean) : ResolvedTheme {
    const selected = normaliseTheme(preference);
    return selected === "auto" ? (systemDark ? "dark" : "light") : selected;
}

/** Storage can be unavailable in restricted browser contexts. */
export function readThemePreference(storage : Pick<Storage, "getItem"> | (() => Pick<Storage, "getItem">)) : ThemePreference {
    try {
        const available = typeof storage === "function" ? storage() : storage;
        return normaliseTheme(available.getItem("theme"));
    } catch {
        return "auto";
    }
}
