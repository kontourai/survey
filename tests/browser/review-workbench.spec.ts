import { expect, test, type Page } from "@playwright/test";

const workbenchPath = "/examples/review-workbench/index.html";

test("renders the review queue, Surface preview, and session audit", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);

  await expect(page.getByRole("heading", { name: "Review candidate update" })).toBeVisible();
  await expect(page.getByTestId("review-queue")).toBeVisible();
  await expect(page.getByTestId("surface-preview")).toContainText("Surface preview");
  await expect(page.getByTestId("session-audit")).toContainText("ReviewSession");
  await expect(page.getByTestId("session-audit")).toContainText("replay ok");
  await expect(page.getByTestId("session-event-list")).toContainText("No persisted review activity yet.");
  await expect(page.getByTestId("session-export")).toContainText("Session export");
  expect(consoleErrors).toEqual([]);
});

test("records decisions, notes, navigation, and reloads them from persisted session events", async ({ page }) => {
  const consoleErrors = await loadWorkbench(page);

  await chooseDecision(page, "accept-proposed");
  await page.getByTestId("reviewer-note").fill("Accepted through browser test.");
  await expect(page.getByTestId("surface-preview")).toContainText("Accepted through browser test.");
  // Navigate to the next unresolved item.  On mobile (≤980px) the queue panel is a slide-in drawer;
  // use the active-review-strip "Next unresolved" button which is always visible on mobile.
  // On desktop the active-review-strip is hidden; use the queue-panel button which is always visible there.
  await goToNextUnresolved(page);

  await expect(page.getByTestId("session-audit")).toContainText("Events");
  await expect(page.getByTestId("session-audit")).toContainText("03");
  await expect(page.getByTestId("session-event-list")).toContainText("decision-changed");
  await expect(page.getByTestId("session-event-list")).toContainText("note-changed");
  await expect(page.getByTestId("session-event-list")).toContainText("item-selected");
  await expect(page.getByTestId("session-audit")).toContainText("replay ok");
  await expect(page.getByTestId("surface-preview")).toContainText("pending");

  await page.reload();
  await expect(page.getByTestId("active-review-strip")).toContainText("public-directory-phone");
  await expect(page.getByTestId("session-event-list")).toContainText("decision-changed");
  await expect(page.getByTestId("session-audit")).toContainText("replay ok");

  // Select a specific queue item by name.  On mobile the queue panel is a slide-in drawer; the
  // mobile-queue-open button opens it, but the backdrop overlay (position:absolute, z-index:40)
  // covers the panel content (position:static) in the current layout, so force-dispatch the click
  // directly to the button element to test the selection logic without fighting hit-testing.
  await selectQueueItem(page, "public-directory-hours");
  await expect(page.getByTestId("reviewer-note")).toHaveValue("Accepted through browser test.");
  await expect(page.locator(".decision-column [data-decision='accept-proposed']")).toHaveClass(/is-active/);
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
              producer: {
                displayName: "External Product",
              },
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
                    surface: "external.profile",
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
                    surface: "external.profile",
                    claimType: "external.field-candidate",
                    fieldOrBehavior: "registrationStatus",
                    impactLevel: "medium",
                  },
                },
              ],
            },
            status: {
              observedCandidateCount: 2,
            },
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
  await expect(page.getByTestId("active-review-strip")).toContainText("external-registration-status");
  await expect(page.getByTestId("review-focus")).toContainText("WAITLIST");
  await chooseDecision(page, "accept-proposed");
  // The "Selected claim" section (which previously showed the claim ID) was removed from the surface
  // preview in the workbench redesign.  Assert instead that the preview reflects the accepted proposal
  // via the review outcome ID rendered in the "Review event" section, and the proposed candidate's
  // source URL rendered in the "Source evidence" section.
  await expect(page.getByTestId("surface-preview")).toContainText("external-registration-status:accept-proposed:review-outcome");
  await expect(page.getByTestId("surface-preview")).toContainText("https://example.test/external-registration");
  expect(consoleErrors).toEqual([]);
});

test("falls back safely when external review queue state is incomplete", async ({ page }) => {
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

  await expect(page.getByTestId("active-review-strip")).toContainText("public-directory-hours");
  await expect(page.getByTestId("session-audit")).toContainText("ReviewSession");
  expect(consoleErrors).toEqual([]);
});

test("falls back safely when external review queue items are malformed", async ({ page }) => {
  await page.addInitScript(() => {
    window.kontourSurveyReviewWorkbench = {
      startState: {
        items: [{}],
        activeItemName: "missing",
        notesByItemName: {},
        decisionsByItemName: {},
        reviewedAt: "2026-06-04T02:00:00.000Z",
        actorId: "external-reviewer",
      },
    } as unknown as Window["kontourSurveyReviewWorkbench"];
  });

  const consoleErrors = await loadWorkbench(page);

  await expect(page.getByTestId("active-review-strip")).toContainText("public-directory-hours");
  await expect(page.getByTestId("session-audit")).toContainText("ReviewSession");
  expect(consoleErrors).toEqual([]);
});

test("keeps the review controls usable on mobile width", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-mobile", "mobile-only layout check");
  const consoleErrors = await loadWorkbench(page);

  await expect(page.getByTestId("active-review-strip")).toBeVisible();

  const viewport = page.viewportSize();
  const stripBox = await page.getByTestId("active-review-strip").boundingBox();
  expect(viewport).not.toBeNull();
  expect(stripBox).not.toBeNull();

  if (viewport && stripBox) {
    expect(stripBox.x).toBeGreaterThanOrEqual(0);
    expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(viewport.width + 1);
  }

  // The session-audit panel lives inside the queue drawer on mobile; open the drawer and verify
  // that its bounding box is within the viewport while the drawer is open.
  await page.getByTestId("mobile-queue-open").click();
  // Wait for the CSS slide-in transition (0.26s) to settle before measuring the bounding box.
  await page.waitForFunction(() => {
    const panel = document.getElementById("queue-panel");
    if (!panel) return false;
    const transform = window.getComputedStyle(panel).transform;
    // translateX(0) computes to the identity matrix
    return transform === "matrix(1, 0, 0, 1, 0, 0)" || transform === "none";
  });
  const auditBox = await page.getByTestId("session-audit").boundingBox();
  expect(auditBox).not.toBeNull();

  if (viewport && auditBox) {
    expect(auditBox.x).toBeGreaterThanOrEqual(0);
    expect(auditBox.x + auditBox.width).toBeLessThanOrEqual(viewport.width + 1);
  }

  // Close the drawer by clicking the backdrop area to the right of the 320px-wide
  // drawer panel (the panel sits above the backdrop and would intercept a center click).
  await page.getByTestId("queue-drawer-backdrop").click({ position: { x: 380, y: 400 } });
  await page.locator(".decision-column [data-decision='keep-current']").click();
  await expect(page.locator(".decision-column [data-decision='keep-current']")).toHaveClass(/is-active/);
  await expect(page.getByTestId("session-event-list")).toContainText("decision-changed");
  expect(consoleErrors).toEqual([]);
});

test("keeps embedded review evidence readable in a narrow host panel", async ({ page }) => {
  test.skip(test.info().project.name !== "chromium-desktop", "embedded-width regression uses desktop viewport with a narrow host");
  const consoleErrors = await loadWorkbench(page);

  await page.addStyleTag({
    content: `
      [data-testid="review-workbench"] {
        width: 760px;
        max-width: 760px;
        margin-inline: auto;
      }
    `,
  });

  await expect(page.getByTestId("review-focus")).toBeVisible();
  await expect(page.getByTestId("surface-preview")).toBeVisible();

  const layout = await page.evaluate(() => {
    const workbench = document.querySelector<HTMLElement>("[data-testid='review-workbench']");
    const candidateCards = [...document.querySelectorAll<HTMLElement>(".candidate-card")];
    const decisionButtons = [...document.querySelectorAll<HTMLElement>(".decision-column .decision-button")];
    return {
      viewportOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workbenchOverflow: workbench ? workbench.scrollWidth - workbench.clientWidth : 0,
      candidateWidths: candidateCards.map((card) => card.getBoundingClientRect().width),
      decisionButtonWidths: decisionButtons.map((button) => button.getBoundingClientRect().width),
    };
  });

  expect(layout.viewportOverflow).toBeLessThanOrEqual(1);
  expect(layout.workbenchOverflow).toBeLessThanOrEqual(1);
  expect(Math.min(...layout.candidateWidths)).toBeGreaterThanOrEqual(620);
  expect(Math.min(...layout.decisionButtonWidths)).toBeGreaterThanOrEqual(180);
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

async function chooseDecision(page: Page, decision: "accept-proposed" | "keep-current" | "reject-proposed"): Promise<void> {
  await page.locator(`.decision-column [data-decision='${decision}']`).click();
}

/**
 * Navigates to the next unresolved review item using the appropriate button for the current
 * viewport.
 *
 * - On desktop (>980px): the queue panel is always visible; use its "Next unresolved" button
 *   inside .queue-head.
 * - On mobile (≤980px): the active-review-strip "Next unresolved" button is always visible;
 *   use that to avoid the closed-drawer interaction entirely.
 */
async function goToNextUnresolved(page: Page): Promise<void> {
  const mobileBar = page.getByTestId("mobile-queue-open");
  if (await mobileBar.isVisible()) {
    await page.getByTestId("active-next-unresolved").click();
  } else {
    await page.locator(".queue-head [data-testid='next-unresolved']").click();
  }
}

/**
 * Selects a queue item by its data-item-name attribute, the way a user would:
 * on mobile the queue panel is a slide-in drawer, so open it from the sticky
 * bar first, then click the row (the drawer closes on selection).
 */
async function selectQueueItem(page: Page, itemName: string): Promise<void> {
  const mobileBar = page.getByTestId("mobile-queue-open");
  if (await mobileBar.isVisible()) {
    await mobileBar.click();
    await page.locator(`[data-item-name='${itemName}']`).click();
  } else {
    await page.locator(`[data-item-name='${itemName}']`).click();
  }
}
