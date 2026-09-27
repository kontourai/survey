/**
 * Playwright browser tests for the standalone Survey Review Console.
 */
import { test, expect } from "@playwright/test";
import { copyFile, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startReviewConsoleServer, type ReviewConsoleServerHandle } from "../../src/console/review-console-server.js";
import { currentSessionState } from "../../src/review-workbench/server-review-session.js";
import { buildReviewSessionEvents } from "../../src/review-workbench/review-workbench.js";

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

test("console page: the bundled embed stylesheet's design tokens resolve", async ({ page }) => {
  // The console serves the packaged embed stylesheet into a .survey-workbench-embed
  // mount, so it shipped with the same dead-token defect as any other embedder
  // (kontourai/survey#202): tokens declared against themselves are a cycle, and
  // every declaration that reads one is dropped at computed-value time.
  await gotoConsole(page);

  const tokens = await page.evaluate(() => {
    const embed = document.querySelector<HTMLElement>(".survey-workbench-embed")!;
    const computed = window.getComputedStyle(embed);
    return {
      brand: computed.getPropertyValue("--k-brand").trim(),
      panel: computed.getPropertyValue("--k-panel").trim(),
      backgroundColor: computed.backgroundColor,
    };
  });

  expect(tokens.brand).not.toBe("");
  expect(tokens.panel).not.toBe("");
  expect(tokens.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
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

for (const failure of [
  { status: 409, message: /not saved because the session changed/ },
  { status: 500, message: /not saved \(HTTP 500/ },
]) {
  test(`console page: a save the server refuses with ${failure.status} is not shown as saved`, async ({ page }) => {
    await gotoConsole(page);

    // The server refuses the save; the stored session stays as it was.
    await page.route("**/api/events", (route) =>
      route.fulfill({
        status: failure.status,
        contentType: "application/json",
        body: JSON.stringify({ error: "refused by test" }),
      }),
    );

    const field = page.locator("[data-testid='review-field']:not([data-state='accepted'])").first();
    const itemName = await field.getAttribute("data-item-name");
    const refetched = page.waitForRequest(
      (req) => req.url().endsWith("/api/session") && req.method() === "GET",
      { timeout: 5000 },
    );
    await field.getByTestId("use-proposed").click();

    // The adapter re-fetches the stored session, re-mounts from it and tells
    // the reviewer; the refused decision is not displayed as saved.
    await refetched;
    await expect(page.getByTestId("console-save-status")).toBeVisible();
    await expect(page.getByTestId("console-save-status")).toHaveText(failure.message);
    await expect(
      page.locator(`[data-testid='review-field'][data-item-name='${itemName}']`),
    ).not.toHaveAttribute("data-state", "accepted");

    const stored = JSON.parse(await readFile(sessionPath, "utf8")) as { events: Array<{ spec: { reviewItemName?: string; eventType: string } }> };
    expect(stored.events.some((e) => e.spec.eventType === "decision-submitted" && e.spec.reviewItemName === itemName)).toBe(false);
  });
}

test("console page: a decision another writer (MCP) stored is kept when the reviewer decides a different item", async ({ page }) => {
  // Write a decision the way survey-review-mcp does: the whole log regenerated
  // under the MCP session name. The console must carry it forward, not replace
  // the log with only its own events.
  const stored = JSON.parse(await readFile(sessionPath, "utf8"));
  const state = currentSessionState(stored.snapshot, stored.events);
  const mcpItem = state.items.find((item: { metadata: { name: string } }) => !state.decisionsByItemName[item.metadata.name])!.metadata.name;
  const mcpEvents = buildReviewSessionEvents(
    { ...state, decisionsByItemName: { ...state.decisionsByItemName, [mcpItem]: "keep-current" } },
    "mcp-review-session",
  );
  await writeFile(sessionPath, JSON.stringify({ ...stored, events: mcpEvents }, null, 2));

  await gotoConsole(page);
  const eventsSaved = page.waitForResponse(
    (resp) => resp.url().includes("/api/events") && resp.request().method() === "POST",
    { timeout: 5000 },
  );
  const field = page.locator(`[data-testid='review-field']:not([data-state='accepted']):not([data-item-name='${mcpItem}'])`).first();
  const consoleItem = await field.getAttribute("data-item-name");
  await field.getByTestId("use-proposed").click();
  expect((await eventsSaved).status()).toBe(200);

  const after = JSON.parse(await readFile(sessionPath, "utf8"));
  const decisions = currentSessionState(after.snapshot, after.events).decisionsByItemName;
  expect(decisions[mcpItem]).toBe("keep-current");
  expect(decisions[consoleItem!]).toBe("accept-proposed");
});
