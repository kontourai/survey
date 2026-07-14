import { expect, test, type Page } from "@playwright/test";

const workbenchPath = "/examples/review-workbench/index.html";

test("renders field-diff cards, progress header, and footer tally", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);

  await expect(page.getByTestId("review-workbench-shell")).toBeVisible();
  await expect(page.getByTestId("review-fields")).toBeVisible();
  const fields = page.getByTestId("review-field");
  await expect(fields).not.toHaveCount(0);
  await expect(page.getByTestId("apply-button")).toBeVisible();
  await expect(page.getByTestId("review-tally")).toContainText("Accepted");
  await expect(page.getByTestId("review-tally")).toContainText("Kept");
  await expect(page.getByTestId("review-tally")).toContainText("Flagged");
  await expect(page.getByTestId("review-tally")).toContainText("Remaining");
  expect(consoleErrors).toEqual([]);
});

test("shows the current -> proposed diff, confidence, and inline source excerpt for a sourced field", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const hoursField = fieldByItemName(page, "public-directory-hours");

  await expect(hoursField.getByTestId("current-value")).toBeVisible();
  await expect(hoursField.getByTestId("proposed-value")).toBeVisible();
  await expect(hoursField.getByTestId("confidence-meter")).toBeVisible();
  await expect(hoursField.getByTestId("proposed-excerpt")).toBeVisible();
  await expect(hoursField.locator(".fkind")).toHaveText("Update");
  expect(consoleErrors).toEqual([]);
});

test("shows 'Not set' and 'Leave unset' for a new field with no current value", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const dropInPrice = fieldByItemName(page, "public-directory-dropin-price");

  await expect(dropInPrice.locator(".fkind")).toHaveText("New");
  await expect(dropInPrice.locator(".val.current")).toHaveClass(/empty/);
  await expect(dropInPrice.getByTestId("current-value")).toHaveText("Not set");
  await expect(dropInPrice.locator("button.btn.keep")).toHaveText("Leave unset");
  expect(consoleErrors).toEqual([]);
});

test("flags a proposed value with no supporting excerpt instead of a weak 'none' placeholder", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const noSourceField = fieldByItemName(page, "public-directory-daily-hours-no-source");

  await expect(noSourceField.getByTestId("no-source-flag")).toBeVisible();
  await expect(noSourceField.getByTestId("no-source-flag")).toContainText("No source");
  await expect(noSourceField.getByTestId("no-source-flag")).toContainText("verify before accepting");
  await expect(noSourceField.getByTestId("confidence-meter")).toHaveCount(0);
  await expect(noSourceField).not.toContainText(/^none$/);
  expect(consoleErrors).toEqual([]);
});

test("a producer-pre-resolved field shows as already decided out of the box", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const resolvedField = fieldByItemName(page, "public-directory-availability");

  await expect(resolvedField).toHaveAttribute("data-state", "kept");
  await expect(resolvedField.getByTestId("field-chip")).toHaveText("Kept current");
  expect(consoleErrors).toEqual([]);
});

test("Use proposed accepts the proposed value and updates the chip, tally, and payload", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const field = fieldByItemName(page, "public-directory-hours");

  await field.getByTestId("use-proposed").click();

  await expect(field).toHaveAttribute("data-state", "accepted");
  await expect(field).toHaveAttribute("data-decided", "1");
  await expect(field.getByTestId("decided-chip")).toHaveText("Accepted");
  await expect(page.getByTestId("tally-accepted")).toHaveText("1");

  await field.getByTestId("audit-details").locator("summary").first().click();
  await expect(field.getByTestId("decision-payload")).toContainText("\"status\": \"verified\"");
  expect(consoleErrors).toEqual([]);
});

test("Keep current keeps the current value; ticking 'Suggestion was wrong' flips it to the reject signal", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const field = fieldByItemName(page, "public-directory-hours");

  await field.getByTestId("keep-current").click();
  await expect(field).toHaveAttribute("data-state", "kept");
  await expect(field.getByTestId("decided-chip")).toHaveText("Kept current");

  await field.getByTestId("undo-decision").click();
  await expect(field).toHaveAttribute("data-decided", "0");

  await field.getByTestId("wrong-toggle").check();
  await field.getByTestId("keep-current").click();
  await expect(field).toHaveAttribute("data-state", "rejected");
  await expect(field.getByTestId("decided-chip")).toHaveText("Kept — flagged wrong");
  expect(consoleErrors).toEqual([]);
});

test("editing the proposed value before accepting threads the edit into the ReviewDecision payload", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const field = fieldByItemName(page, "public-directory-hours");

  await field.getByTestId("edit-proposed-value").fill("Weekdays 7am-7pm");
  await field.getByTestId("use-proposed").click();

  await expect(field.getByTestId("proposed-value")).toHaveText("Weekdays 7am-7pm");
  await field.getByTestId("audit-details").locator("summary").first().click();
  await expect(field.getByTestId("decision-payload")).toContainText("\"editedValue\": \"Weekdays 7am-7pm\"");
  expect(consoleErrors).toEqual([]);
});

test("records decisions and reviewer notes, persists them to localStorage, and reloads them", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const field = fieldByItemName(page, "public-directory-hours");

  await field.getByTestId("use-proposed").click();
  await field.getByTestId("audit-details").locator("summary").first().click();
  await field.getByTestId("reviewer-note").fill("Accepted through browser test.");
  await expect(field.getByTestId("decision-payload")).toContainText("Accepted through browser test.");

  await page.reload();
  const reloadedField = fieldByItemName(page, "public-directory-hours");
  await expect(reloadedField).toHaveAttribute("data-state", "accepted");
  await reloadedField.getByTestId("audit-details").locator("summary").first().click();
  await expect(reloadedField.getByTestId("reviewer-note")).toHaveValue("Accepted through browser test.");
  expect(consoleErrors).toEqual([]);
});

test("boots from an externally supplied review queue session", async ({ page }) => {
  await page.addInitScript(() => {
    window.kontourSurveyReviewWorkbench = {
      startState: {
        items: [
          {
            apiVersion: "survey.kontourai.io/v1alpha1",
            kind: "ReviewItem",
            metadata: {
              name: "external-registration-status",
              producer: { displayName: "External Product" },
            },
            spec: {
              target: "registrationStatus",
              candidateSetStatus: "needs-review",
              candidates: [
                {
                  id: "external-registration-status:current",
                  role: "current",
                  value: "OPEN",
                  source: {
                    sourceRef: "external://current-record",
                    kind: "manual-entry",
                    observedAt: "2026-06-04T00:00:00.000Z",
                  },
                  locator: {
                    scheme: "structured-field",
                    locator: "field:registrationStatus",
                    excerpt: "Current registration status.",
                  },
                  extraction: {
                    target: "registrationStatus",
                    extractor: "external-current-record",
                    extractedAt: "2026-06-04T00:00:00.000Z",
                  },
                  claimTarget: {
                    claimId: "external.registrationStatus.current",
                    subjectType: "external.entity",
                    subjectId: "entity-1",
                    facet: "external.profile",
                    claimType: "external.field",
                    fieldOrBehavior: "registrationStatus",
                    impactLevel: "medium",
                  },
                },
                {
                  id: "external-registration-status:proposed",
                  role: "proposed",
                  value: "WAITLIST",
                  confidence: 0.88,
                  source: {
                    sourceRef: "https://example.test/external-registration",
                    kind: "web-page",
                    observedAt: "2026-06-04T01:00:00.000Z",
                  },
                  locator: {
                    scheme: "html",
                    locator: "html:field=registrationStatus",
                    excerpt: "Registration is waitlist only.",
                  },
                  extraction: {
                    target: "registrationStatus",
                    confidence: 0.88,
                    extractor: "external-crawler",
                    extractedAt: "2026-06-04T01:00:00.000Z",
                  },
                  claimTarget: {
                    claimId: "external.registrationStatus.proposed",
                    subjectType: "external.entity",
                    subjectId: "entity-1",
                    facet: "external.profile",
                    claimType: "external.field-candidate",
                    fieldOrBehavior: "registrationStatus",
                    impactLevel: "medium",
                  },
                },
              ],
            },
            status: { observedCandidateCount: 2 },
          },
        ],
        activeItemName: "external-registration-status",
        notesByItemName: {},
        decisionsByItemName: {},
        reviewedAt: "2026-06-04T02:00:00.000Z",
        actorId: "external-reviewer",
      },
    };
  });

  const consoleErrors = await loadWorkbench(page);

  await expect(page.getByText("External Product")).toBeVisible();
  const field = fieldByItemName(page, "external-registration-status");
  await expect(field.getByTestId("proposed-value")).toHaveText("WAITLIST");
  await field.getByTestId("use-proposed").click();
  await field.getByTestId("audit-details").locator("summary").first().click();
  await expect(field.getByTestId("decision-payload")).toContainText("external-registration-status:accept-proposed:review-outcome");
  expect(consoleErrors).toEqual([]);
});

test("falls back safely when external review queue state is incomplete or malformed", async ({ page }) => {
  await page.addInitScript(() => {
    window.kontourSurveyReviewWorkbench = {
      startState: {
        items: [],
        activeItemName: "incomplete",
        reviewedAt: "2026-06-04T02:00:00.000Z",
        actorId: "external-reviewer",
      },
    } as unknown as Window["kontourSurveyReviewWorkbench"];
  });

  const consoleErrors = await loadWorkbench(page);

  await expect(fieldByItemName(page, "public-directory-hours")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("keeps embedded review evidence readable in a narrow host panel", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-desktop", "embedded-width regression uses desktop viewport with a narrow host");
  const consoleErrors = await loadWorkbench(page);

  await page.addStyleTag({
    content: `
      [data-testid="review-workbench"] {
        width: 480px;
        max-width: 480px;
        margin-inline: auto;
      }
    `,
  });

  const layout = await page.evaluate(() => ({
    viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));

  expect(layout.viewportOverflow).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("review-fields")).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("keeps the review controls usable on mobile width", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-mobile", "mobile-only layout check");
  const consoleErrors = await loadWorkbench(page);

  const field = fieldByItemName(page, "public-directory-hours");
  const viewport = page.viewportSize();
  const fieldBox = await field.boundingBox();
  expect(viewport).not.toBeNull();
  expect(fieldBox).not.toBeNull();
  if (viewport && fieldBox) {
    expect(fieldBox.x).toBeGreaterThanOrEqual(0);
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(viewport.width + 1);
  }

  // Nothing may force a horizontal scroll — mobile is the primary context.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  // current → proposed stack vertically at this width (single-column diff).
  const currentBox = await field.getByTestId("current-value").boundingBox();
  const proposedBox = await field.getByTestId("proposed-value").boundingBox();
  expect(currentBox).not.toBeNull();
  expect(proposedBox).not.toBeNull();
  if (currentBox && proposedBox) {
    expect(proposedBox.y).toBeGreaterThanOrEqual(currentBox.y + currentBox.height - 1);
  }

  // Decision buttons are full-width and tall enough to tap comfortably.
  const useBtn = field.getByTestId("use-proposed");
  const keepBtn = field.getByTestId("keep-current");
  const useBox = await useBtn.boundingBox();
  const keepBox = await keepBtn.boundingBox();
  expect(useBox).not.toBeNull();
  expect(keepBox).not.toBeNull();
  if (useBox && keepBox && fieldBox) {
    expect(useBox.height).toBeGreaterThanOrEqual(44);
    expect(keepBox.height).toBeGreaterThanOrEqual(44);
    // Full-width: each button spans most of the card's inner width.
    expect(useBox.width).toBeGreaterThan(fieldBox.width * 0.6);
    expect(keepBox.width).toBeGreaterThan(fieldBox.width * 0.6);
  }

  await keepBtn.click();
  await expect(field).toHaveAttribute("data-state", "kept");
  expect(consoleErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// AUDIT DETAILS: single collapsed power-user surface per field
// ---------------------------------------------------------------------------

test("audit details are collapsed by default and expand to show trace IDs; the JSON payload appears only after a decision (never a bare null)", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);
  const field = fieldByItemName(page, "public-directory-hours");
  const details = field.getByTestId("audit-details");

  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").first().click();
  await expect(details).toHaveAttribute("open", "");
  await expect(details).toContainText("Proposed candidate ID");

  // Before any decision: a plain-language prompt, and NO null payload leak.
  await expect(details).toContainText("No decision recorded yet");
  await expect(field.getByTestId("decision-payload")).toHaveCount(0);
  await expect(details).not.toContainText("Surface projection");

  // After a decision: the saved-record JSON appears under the reworded summary.
  await field.getByTestId("use-proposed").click();
  await field.getByTestId("audit-details").locator("summary").first().click();
  await expect(field.getByTestId("audit-details")).toContainText("Saved record (JSON)");
  await expect(field.getByTestId("decision-payload")).toContainText("\"kind\": \"ReviewDecision\"");
  expect(consoleErrors).toEqual([]);
});

test("excerpt clamp toggle expands and collapses a long excerpt inside audit details", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-desktop", "clamp test uses desktop viewport");

  await page.addInitScript(() => {
    const longExcerpt = "This is a very long excerpt text that should be clamped to three lines when rendered in the workbench. ".repeat(8);
    window.kontourSurveyReviewWorkbench = {
      startState: {
        items: [
          {
            apiVersion: "survey.kontourai.io/v1alpha1",
            kind: "ReviewItem",
            metadata: { name: "clamp-test-item", producer: { displayName: "Clamp Test" } },
            spec: {
              target: "clampField",
              candidateSetStatus: "needs-review",
              candidates: [
                {
                  id: "clamp-test:current",
                  role: "current",
                  value: "current value",
                  source: { sourceRef: "https://example.test/clamp", kind: "web-page", observedAt: "2026-06-04T00:00:00.000Z" },
                  locator: { scheme: "html", locator: "html:field=clampField", excerpt: longExcerpt },
                  extraction: { target: "clampField", extractor: "test", extractedAt: "2026-06-04T00:00:00.000Z" },
                  claimTarget: { claimId: "clamp.current", subjectType: "test", subjectId: "x", facet: "test", claimType: "test", fieldOrBehavior: "clampField", impactLevel: "low" },
                },
                {
                  id: "clamp-test:proposed",
                  role: "proposed",
                  value: "proposed value",
                  source: { sourceRef: "https://example.test/clamp-proposed", kind: "web-page", observedAt: "2026-06-04T01:00:00.000Z" },
                  locator: { scheme: "html", locator: "html:field=clampField", excerpt: longExcerpt },
                  extraction: { target: "clampField", extractor: "test-crawler", extractedAt: "2026-06-04T01:00:00.000Z" },
                  claimTarget: { claimId: "clamp.proposed", subjectType: "test", subjectId: "x", facet: "test", claimType: "test", fieldOrBehavior: "clampField", impactLevel: "low" },
                },
              ],
            },
            status: { observedCandidateCount: 2 },
          },
        ],
        activeItemName: "clamp-test-item",
        notesByItemName: {},
        decisionsByItemName: { "clamp-test-item": "accept-proposed" },
        reviewedAt: "2026-06-04T00:00:00.000Z",
        actorId: "clamp-tester",
      },
    } as unknown as Window["kontourSurveyReviewWorkbench"];
  });

  const consoleErrors = await loadWorkbench(page);
  const field = fieldByItemName(page, "clamp-test-item");
  await field.getByTestId("audit-details").locator("summary").first().click();

  const clampContainer = field.locator(".excerpt-clamp").first();
  const toggleButton = clampContainer.locator("[data-clamp-toggle]");

  await expect(clampContainer).toBeVisible();
  await expect(toggleButton).toHaveText("more");
  await expect(clampContainer).not.toHaveClass(/is-expanded/);

  await toggleButton.click();
  await expect(toggleButton).toHaveText("less");
  await expect(clampContainer).toHaveClass(/is-expanded/);

  await toggleButton.click();
  await expect(toggleButton).toHaveText("more");
  await expect(clampContainer).not.toHaveClass(/is-expanded/);

  expect(consoleErrors).toEqual([]);
});

// ---------------------------------------------------------------------------
// DEMO PAGE CHROME: light/dark toggle persisted
// ---------------------------------------------------------------------------

test("demo page light/dark toggle changes theme and persists to localStorage", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-desktop", "theme toggle test uses desktop viewport");
  const consoleErrors = await loadWorkbench(page);

  const toggle = page.getByTestId("demo-theme-toggle");
  await expect(toggle).toBeVisible();

  const initialTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(initialTheme).toBeNull();

  const darkKBg = await page.evaluate(() =>
    window.getComputedStyle(document.documentElement).getPropertyValue("--k-bg").trim(),
  );
  expect(darkKBg).not.toBe("");

  await toggle.click();

  const lightTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(lightTheme).toBe("light");

  const stored = await page.evaluate(() => {
    try { return localStorage.getItem("survey-demo-color-scheme"); } catch { return null; }
  });
  expect(stored).toBe("light");

  const lightKBg = await page.evaluate(() =>
    window.getComputedStyle(document.documentElement).getPropertyValue("--k-bg").trim(),
  );
  expect(lightKBg).not.toBe(darkKBg);

  await toggle.click();
  const backToDark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  expect(backToDark).toBeNull();

  expect(consoleErrors).toEqual([]);
});

async function loadWorkbench(page: Page): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto(workbenchPath);
  await expect(page.getByTestId("review-workbench")).toBeVisible();
  return consoleErrors;
}

function fieldByItemName(page: Page, itemName: string) {
  return page.locator(`[data-testid='review-field'][data-item-name='${itemName}']`);
}
