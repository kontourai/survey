/**
 * Browser cover for the score-blind session (#296) and the field-state panel
 * (#294) on the mounted, packaged workbench. Set SURVEY_RENDER_DIR to also
 * save a screenshot of each surface per viewport.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { buildCandidateVerification } from "../../src/candidate-verification.js";
import { deriveFieldStates } from "../../src/field-states.js";
import type { ReviewItem } from "../../src/review-resource.js";
import { initialReviewQueueSessionState } from "../../src/review-workbench/review-queue-session.js";
import { buildEnvelopeImportFixture } from "../envelope-review-fixture.js";
import { importFields, slot } from "../field-state-fixture.js";

const fixturePath = "/tests/browser/fixtures/review-workbench-states.html";

async function mount(page: Page, fixture: Record<string, unknown>): Promise<string[]> {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript((value) => {
    (window as unknown as Record<string, unknown>).__surveyStatesFixture = value;
  }, JSON.parse(JSON.stringify(fixture)));
  await page.goto(fixturePath);
  await expect(page.getByTestId("review-fields")).toBeVisible();
  return pageErrors;
}

async function render(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = process.env.SURVEY_RENDER_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${testInfo.project.name}-${name}.png`), fullPage: true });
}

/** Envelope items with confidence 0.9 and a verifier record on the first. */
function scoredItems(): ReviewItem[] {
  const imported = buildEnvelopeImportFixture();
  const items = JSON.parse(JSON.stringify(imported.reviewItems)) as ReviewItem[];
  const candidate = items[0]!.spec.candidates[0]!;
  candidate.verifications = [JSON.parse(JSON.stringify(buildCandidateVerification({
    input: { candidateId: candidate.id, value: candidate.value, evidence: [{ id: "ev", excerpt: candidate.locator!.excerpt!, locator: candidate.locator!.locator! }] },
    verifier: { id: "support-check", version: "2.1.0", method: "model" },
    verdict: { result: "supported" },
    createdAt: "2026-09-28T12:00:00.000Z",
  })))];
  return items;
}

test.describe("score-blind session", () => {
  test("renders no confidence meter or verifier result, before or after a decision", async ({ page }, testInfo) => {
    const items = scoredItems();
    const sighted = await mount(page, { session: initialReviewQueueSessionState(items) });
    // Control: the same queue shows the meter when the session is not blind.
    await expect(page.getByTestId("confidence-meter").first()).toBeVisible();
    await expect(page.getByTestId("support-verification")).toHaveCount(1);
    expect(sighted).toEqual([]);

    const blind = await mount(page, {
      session: { ...initialReviewQueueSessionState(items), presentation: { scoreBlind: true }, sampling: { kind: "random-audit", rate: 0.25, seed: "audit-2026-09" } },
    });
    await expect(page.getByTestId("score-blind-notice")).toBeVisible();
    await expect(page.getByTestId("confidence-meter")).toHaveCount(0);
    await expect(page.getByTestId("support-verification")).toHaveCount(0);
    await expect(page.getByTestId("proposed-excerpt")).toHaveCount(items.length);
    await render(page, testInfo, "score-blind");

    await page.getByTestId("use-proposed").first().click();
    await expect(page.locator('[data-testid="review-field"][data-decided="1"]')).toHaveCount(1);
    await expect(page.getByTestId("confidence-meter")).toHaveCount(0);
    await expect(page.getByTestId("support-verification")).toHaveCount(0);
    // The saved decision records the blind presentation and the sample.
    const decided = page.locator('[data-testid="review-field"][data-decided="1"]');
    await decided.getByTestId("audit-details").locator(":scope > summary").click();
    const payload = decided.getByTestId("decision-payload");
    await expect(payload).toContainText('"scoreBlind": true');
    await expect(payload).toContainText('"random-audit"');
    expect(blind).toEqual([]);
  });
});

test.describe("field-state panel", () => {
  test("lists a field that was not read and follows the reviewer's decisions", async ({ page }, testInfo) => {
    const imported = importFields([
      { field: "annualFee", value: 48000, excerpt: "48000", confidence: 0.82 },
      { field: "vendorName", value: "Acme", excerpt: "Acme" },
      { field: "vendorName", value: "Acme Corp", excerpt: "Acme Corp" },
      { field: "renewalDate", value: "2027-03-31", excerpt: "2027-03-31" },
    ], { partial: true, mismatched: [3] });
    const fieldStates = deriveFieldStates({
      imports: [{ record: imported.record, expectedFields: ["annualFee", "vendorName", "renewalDate", "terminationNotice"].map(slot) }],
    });
    const errors = await mount(page, { session: initialReviewQueueSessionState(imported.reviewItems), extractionImport: imported.record, fieldStates });
    const panel = page.getByTestId("field-states");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("field-states-incomplete")).toBeVisible();
    const row = (field: string) => panel.locator(`[data-testid="field-state"][data-field="${field}"]`);
    await expect(row("terminationNotice")).toHaveAttribute("data-content", "not_covered");
    await expect(row("renewalDate")).toHaveAttribute("data-content", "excluded");
    await expect(row("renewalDate").getByTestId("field-state-signal")).toHaveCount(2);
    await expect(page.getByTestId("field-states-incomplete")).toContainText("1 field was not read");
    await expect(row("vendorName")).toHaveAttribute("data-content", "conflicting");
    await expect(row("annualFee")).toHaveAttribute("data-lifecycle", "pending");

    await page.locator('[data-testid="review-field"][data-field="annualFee"]').getByTestId("use-proposed").click();
    await expect(row("annualFee")).toHaveAttribute("data-lifecycle", "accepted");
    await render(page, testInfo, "field-states");
    expect(errors).toEqual([]);
  });
});
