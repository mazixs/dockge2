import { expect, test } from "@playwright/test";
import { E2E_ATTENTION_STACK, E2E_STACK_NAME } from "./constants";

test.describe("stack status in the UI", () => {
    test("a healthy stack is active and a partly stopped one asks for attention", async ({ page }) => {
        await page.goto("/");

        // The stack whose only service runs is active
        const healthyRow = page.locator(".item", { hasText: E2E_STACK_NAME });
        await expect(healthyRow.locator(".badge")).toHaveText(/active/i);

        // The stack with an unmarked container that exited is not called inactive
        const attentionRow = page.locator(".item", { hasText: E2E_ATTENTION_STACK });
        await expect(attentionRow.locator(".badge")).toHaveText(/attention/i);
        await expect(attentionRow.locator(".badge")).not.toHaveText(/inactive/i);
    });

    test("the stack page explains why a stack needs attention", async ({ page }) => {
        await page.goto(`/compose/${E2E_ATTENTION_STACK}`);

        // The reason names the service and what is wrong with it
        const panel = page.locator(".alert-warning", { hasText: "Needs attention" });
        await expect(panel).toBeVisible();
        await expect(panel).toContainText("init");
        await expect(panel).toContainText("service stopped");

        // The running service is not presented as dead
        const runningService = page.locator(".container", { hasText: "app" }).first();
        await expect(runningService.locator(".badge").first()).toHaveText(/running/i);

        // The stopped one-shot container is marked, with its own instance line
        const stoppedService = page.locator(".container", { hasText: "init" }).first();
        await expect(stoppedService.locator(".instance-list")).toContainText("service stopped");
    });
});
