/**
 * Playwright browser tests for the standalone Survey Review Console.
 */
import { test, expect } from "@playwright/test";
import { copyFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startReviewConsoleServer, type ReviewConsoleServerHandle } from "../../src/console/review-console-server.js";

const SAMPLE_SESSION = "example-data/mcp-review-session.json";

let tmpDir: string;
let sessionPath: string;
let handle: ReviewConsoleServerHandle;

test.beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "survey-console-browser-test-"));
  sessionPath = join(tmpDir, "session.json");
  await copyFile(SAMPLE_SESSION, sessionPath);
  handle = await startReviewConsoleServer({ sessionPath, port: 0 });
});

test.afterAll(async () => {
  await handle.close();
  await rm(tmpDir, { recursive: true, force: true });
});

async function gotoConsole(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(handle.url);
  // The workbench is mounted asynchronously after fetching /api/session;
  // wait for the review fields (rendered by mountReviewWorkbench) to appear.
  await expect(page.getByTestId("review-workbench")).toBeVisible();
  await expect(page.getByTestId("review-fields")).toBeVisible({ timeout: 10000 });
}

test("console page: workbench renders the review queue", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await gotoConsole(page);
  expect(consoleErrors).toEqual([]);
});

test("console page: make a decision and assert it persists (reload shows resolved)", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await gotoConsole(page);

  // Set up the response listener BEFORE clicking so we don't miss it
  const eventsSaved = page.waitForResponse(
    (resp) => resp.url().includes("/api/events") && resp.status() === 200,
    { timeout: 5000 },
  );

  // Accept the proposed value on the first field card
  const firstField = page.locator("[data-testid='review-field']").first();
  const itemName = await firstField.getAttribute("data-item-name");
  await firstField.getByTestId("use-proposed").click();
  await expect(firstField).toHaveAttribute("data-state", "accepted");

  // Wait for the POST to /api/events to complete
  await eventsSaved;

  // Verify the session file on disk was mutated
  const raw = await readFile(sessionPath, "utf8");
  const content = JSON.parse(raw) as { events: unknown[] };
  expect(content.events.length).toBeGreaterThan(0);

  // Reload the page — the decision should be restored from persisted events
  await page.reload();
  await expect(page.getByTestId("review-fields")).toBeVisible({ timeout: 10000 });

  // The same field should now show accepted as its restored state
  await expect(page.locator(`[data-testid='review-field'][data-item-name='${itemName}']`)).toHaveAttribute("data-state", "accepted");
  expect(consoleErrors).toEqual([]);
});

test("console page: connection indicator is present", async ({ page }) => {
  await gotoConsole(page);
  const indicator = page.locator("#connection-indicator");
  await expect(indicator).toBeVisible();
});

test("console page: theme toggle switches theme", async ({ page }) => {
  await gotoConsole(page);

  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toBeVisible();

  const initialTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(initialTheme).toBeNull(); // default dark

  await toggle.click();
  const lightTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(lightTheme).toBe("light");

  await toggle.click();
  const backToDark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(backToDark).toBeNull();
});
