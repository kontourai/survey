import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startReviewConsoleServer } from "../../src/console/review-console-server.js";
import { bindReviewQueue } from "../../src/review-workbench/queue-binding.js";

test("saved browser review reaches the producer and reload prevents a second application", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "survey-browser-apply-"));
  const sessionPath = join(root, "session.json");
  const content = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8"));
  const snapshot = { ...content.snapshot, items: content.snapshot.items.slice(0, 1), decisionsByItemName: {}, notesByItemName: {} };
  await writeFile(sessionPath, JSON.stringify({ ...content, snapshot, events: [] }));
  let calls = 0;
  const handle = await startReviewConsoleServer({ sessionPath, producerApply: {
    binding: bindReviewQueue(snapshot, { sessionName: content.session.metadata.name }),
    apply: async ({ results, events }) => {
      expect(results[0].decision).toBe("accept-proposed");
      expect(events.length).toBeGreaterThan(0);
      calls++;
      return { reference: "workflow:browser-observed", summary: "Workflow recorded this review" };
    },
  } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/api/events", async route => { await new Promise(resolve => setTimeout(resolve, 150)); await route.continue(); });
    await page.goto(handle.url);
    await expect(page.getByTestId("review-fields")).toBeVisible();
    await page.getByTestId("use-proposed").click();
    const sent = page.waitForResponse(response => response.url().endsWith("/api/apply"));
    await page.getByRole("button", { name: "Send review to workflow" }).click();
    expect((await sent).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Send review to workflow" })).toBeDisabled();
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(sessionPath, "utf8")).producerApplication.reference).toBe("workflow:browser-observed");
    await page.reload();
    await expect(page.getByRole("button", { name: "Send review to workflow" })).toBeDisabled();
    expect(errors).toEqual([]);
  } finally { await page.close(); await handle.close(); await rm(root, { recursive: true }); }
});

test("a producer's stale workflow refusal stays visible and leaves the browser review unapplied", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "survey-browser-stale-"));
  const sessionPath = join(root, "session.json");
  const content = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8"));
  const snapshot = { ...content.snapshot, items: content.snapshot.items.slice(0, 1), decisionsByItemName: {}, notesByItemName: {} };
  await writeFile(sessionPath, JSON.stringify({ ...content, snapshot, events: [] }));
  const handle = await startReviewConsoleServer({ sessionPath, producerApply: {
    binding: bindReviewQueue(snapshot, { sessionName: content.session.metadata.name }),
    apply: async () => { throw new Error("Current workflow visit changed"); },
  } });
  try {
    await page.goto(handle.url);
    await expect(page.getByTestId("review-fields")).toBeVisible();
    await page.getByTestId("use-proposed").click();
    const refused = page.waitForResponse(response => response.url().endsWith("/api/apply"));
    await page.getByRole("button", { name: "Send review to workflow" }).click();
    expect((await refused).status()).toBe(409);
    await expect(page.getByTestId("console-save-status")).toContainText("Current workflow visit changed");
    await expect(page.getByRole("button", { name: "Send review to workflow" })).toBeEnabled();
    expect(JSON.parse(await readFile(sessionPath, "utf8")).producerApplication).toBeUndefined();
  } finally { await page.close(); await handle.close(); await rm(root, { recursive: true }); }
});
