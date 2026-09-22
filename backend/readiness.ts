/**
 * Essential readiness is independent of managed stacks and remote registries.
 * Initialization includes both application migrations and the auth schema.
 */
export class Readiness {
    initialized = false;
    private inFlight : Promise<boolean> | undefined;

    /**
     * Bound and share the database probe so polling cannot queue unbounded work.
     * @param stopping Whether shutdown has started
     * @param query Query the required application and auth tables
     * @returns Whether the initialized application can serve requests
     */
    async check(stopping : () => boolean, query : () => Promise<unknown>) : Promise<boolean> {
        if (!this.initialized || stopping()) {
            return false;
        }
        this.inFlight ??= query().then(() => true, () => false).finally(() => {
            this.inFlight = undefined;
        });
        let timer : NodeJS.Timeout | undefined;
        try {
            const healthy = await Promise.race([ this.inFlight, new Promise<false>(resolve => {
                timer = setTimeout(() => resolve(false), 1500);
            }) ]);
            return healthy && this.initialized && !stopping();
        } finally {
            clearTimeout(timer);
        }
    }
}
