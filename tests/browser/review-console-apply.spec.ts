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
    await expect(page.getByTestId("apply-button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send review to workflow" })).toBeDisabled();
    await page.getByTestId("use-proposed").click();
    const sent = page.waitForResponse(response => response.url().endsWith("/api/apply"));
    await page.getByRole("button", { name: "Send review to workflow" }).click();
    expect((await sent).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Send review to workflow" })).toBeDisabled();
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(sessionPath, "utf8")).producerApplication.reference).toBe("workflow:browser-observed");
    await expect(page.getByTestId("console-save-status")).toHaveAttribute("role", "status");
    await expect(page.getByTestId("console-save-status")).toContainText("Workflow recorded this review");
    await page.reload();
    await expect(page.getByTestId("console-save-status")).toContainText("Workflow recorded this review");
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

for (const failedSave of [false, true]) test(`named actions preserve replay and gate pending${failedSave ? " and failed" : ""} saves`, async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "survey-presented-review-"));
  const sessionPath = join(root, "session.json");
  const content = JSON.parse(await readFile("example-data/mcp-review-session.json", "utf8"));
  const document = structuredClone(content.snapshot.items[0]);
  document.spec.candidates = document.spec.candidates.filter((c: { role: string }) => c.role === "proposed");
  const action = structuredClone(content.snapshot.items[1]);
  const base = action.spec.candidates.find((c: { role: string }) => c.role === "proposed");
  action.spec.candidates = [{ ...base, id: "approve", value: "Approve proposal" }, { ...structuredClone(base), id: "change", value: "Request changes" }];
  const snapshot = { ...content.snapshot, items: [document, action], decisionsByItemName: {}, notesByItemName: {} };
  await writeFile(sessionPath, JSON.stringify({ ...content, snapshot, events: [] }));
  let calls = 0;
  const handle = await startReviewConsoleServer({ sessionPath, presentation: {
    title: "Proposal review", context: "Open finding: missing entity.\n<script>unsafe()</script>", items: {
      [document.metadata.name]: { kind: "acknowledgment", title: "Document" },
      [action.metadata.name]: { kind: "choice", title: "Decision", candidateLabels: { approve: "Approve", change: "Request changes" } },
    },
  }, producerApply: { binding: bindReviewQueue(snapshot, { sessionName: content.session.metadata.name }), apply: async ({ results }) => {
    calls++;
    expect(results.find(r => r.reviewItemName === action.metadata.name)?.decision).toBe("select-proposed");
    return { reference: "workflow:named-action", summary: "Changes requested. Continue the original run." };
  } } });
  try {
    await page.goto(handle.url);
    await expect(page.getByTestId("review-context")).toContainText("Open finding: missing entity.");
    expect(await page.getByTestId("review-context").locator("script").count()).toBe(0);
    await expect(page.getByTestId("review-context")).toHaveCSS("white-space", "pre-wrap");
    await expect(page.getByTestId("review-context")).toHaveCSS("padding-top", "16px");
    await expect(page.getByRole("button", { name: "Mark reviewed", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(sessionPath, "utf8")).events.length).toBeGreaterThan(0);
    await page.reload();
    const actionCard = page.locator(`[data-testid="review-field"][data-item-name="${action.metadata.name}"]`);
    await expect(actionCard.getByTestId("reviewer-note")).toBeVisible();
    await actionCard.getByTestId("reviewer-note").fill("Add the missing entity.");
    await expect.poll(async () => JSON.parse(await readFile(sessionPath, "utf8")).events.some((e: { spec: { eventType: string } }) => e.spec.eventType === "note-changed")).toBe(true);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let intercepted!: () => void;
    const seen = new Promise<void>(resolve => { intercepted = resolve; });
    await page.route("**/api/events", async route => {
      intercepted(); await held;
      if (failedSave) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Deliberate save refusal" }) });
      else await route.continue();
    });
    await actionCard.getByRole("button", { name: "Request changes", exact: true }).click();
    await seen;
    await expect(page.locator("#apply-review")).toBeDisabled();
    release();
    if (failedSave) {
      await expect(page.getByTestId("console-save-status")).toContainText("Deliberate save refusal");
      await expect(page.locator("#apply-review")).toBeDisabled();
      expect(calls).toBe(0);
      expect(JSON.parse(await readFile(sessionPath, "utf8")).events.some((e: { spec: { candidateId?: string } }) => e.spec.candidateId === "change")).toBe(false);
    } else {
      await expect(page.locator("#apply-review")).toBeEnabled();
      await page.reload();
      await expect(page.locator("#apply-review")).toBeEnabled();
      await expect(actionCard.getByTestId("reviewer-note")).toHaveValue("Add the missing entity.");
      await page.locator("#apply-review").click();
      await expect(page.getByTestId("console-save-status")).toContainText("Changes requested. Continue the original run.");
      await expect(page.getByTestId("console-save-status")).toHaveAttribute("data-state", "success");
      expect(calls).toBe(1);
    }
  } finally { await page.close(); await handle.close(); await rm(root, { recursive: true }); }
});
