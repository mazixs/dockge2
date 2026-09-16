import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { MachineIdentity } from "./mcp-keys";

interface Invocation {
    identity : MachineIdentity;
    refresh : () => Promise<MachineIdentity>;
}

/** Remote keys have a separate namespace, never a row or session in local authentication. */
export function delegatedSubjectId(issuer : string, keyId : string) : string {
    return "peer:" + createHash("sha256").update(JSON.stringify([ issuer, keyId ])).digest("hex");
}

/** A per-invocation authority source allows the ordinary durable registry to recheck a remote key. */
export class DelegatedInvocation {
    private storage = new AsyncLocalStorage<Invocation>();

    /** Pass this callback to the shared service's ordinary current-authority dependency. */
    refresh = async (keyId : string) : Promise<MachineIdentity> => {
        const invocation = this.storage.getStore();
        if (!invocation || invocation.identity.keyId !== keyId) {
            throw new Error("mcpPermissionDenied");
        }
        const fresh = await invocation.refresh();
        if (fresh.keyId !== keyId || fresh.userId !== invocation.identity.userId) {
            throw new Error("mcpPermissionDenied");
        }
        return fresh;
    };

    /** Prepared operations retain data, not this context; each later apply supplies fresh authority. */
    run<T>(identity : MachineIdentity, refresh : () => Promise<MachineIdentity>, execute : () => Promise<T>) : Promise<T> {
        return this.storage.run({ identity,
            refresh }, execute);
    }
}
