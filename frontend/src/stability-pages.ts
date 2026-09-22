import type { StabilityGroup } from "../../common/stability";

/** Bound rendered rows while preserving stack groups and authoritative total counts. */
export function stabilityPage(stacks : readonly StabilityGroup[], requested = 1, size = 50) {
    const total = stacks.reduce((sum, stack) => sum + stack.containers.length, 0);
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(pages, Math.max(1, requested));
    const start = (current - 1) * size;
    const groups : (StabilityGroup & { totalContainers : number })[] = [];
    let offset = 0;
    for (const stack of stacks) {
        const from = Math.max(0, start - offset);
        const to = Math.min(stack.containers.length, start + size - offset);
        if (to > from) {
            groups.push({ ...stack,
                totalContainers: stack.containers.length,
                containers: stack.containers.slice(from, to) });
        }
        offset += stack.containers.length;
    }
    return { groups,
        total,
        pages,
        current };
}
