import { execFileSync } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const stackName = "e2e-delete-git";
const stacksDir = process.env.DOCKGE_E2E_STACKS_DIR ?? "/tmp/dockge-e2e/stacks";
const stackDir = path.join(stacksDir, stackName);

test("unconfigured Git stack can be deleted without fixing Compose", async ({ page }) => {
    const invalidCompose = "services:\n  app:\n    image: ${DOCKGE_E2E_DELETE_IMAGE:?Set DOCKGE_E2E_DELETE_IMAGE before deploying}\n";
    await mkdir(stackDir, { recursive: true });
    execFileSync("git", [ "init", stackDir ], { stdio: "ignore" });
    await writeFile(path.join(stackDir, "compose.yaml"), invalidCompose);

    try {
        await page.goto(`/stack/${stackName}`);
        await page.locator(".head .actions").getByRole("button", { name: /^(more|еще)$/i }).click();
        await page.getByRole("menuitem", { name: /^(delete|удалить)$/i }).click();
        await page.getByRole("dialog").getByRole("button", { name: /^(delete|удалить)$/i }).click();

        await expect(page).toHaveURL(/\/$/);
        await expect(async () => {
            await expect(access(stackDir)).rejects.toThrow();
        }).toPass();
    } finally {
        // This fixture never creates containers; remove only its own temporary files.
        await rm(stackDir, { recursive: true,
            force: true });
    }
});
