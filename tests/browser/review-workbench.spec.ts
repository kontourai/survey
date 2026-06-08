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
  await page.locator(".queue-head [data-testid='next-unresolved']").click();

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

  await page.locator("[data-item-name='public-directory-hours']").click();
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
  await expect(page.getByTestId("surface-preview")).toContainText("external.registrationStatus.proposed");
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
  await expect(page.getByTestId("session-audit")).toBeVisible();

  const viewport = page.viewportSize();
  const stripBox = await page.getByTestId("active-review-strip").boundingBox();
  const auditBox = await page.getByTestId("session-audit").boundingBox();
  expect(viewport).not.toBeNull();
  expect(stripBox).not.toBeNull();
  expect(auditBox).not.toBeNull();

  if (viewport && stripBox && auditBox) {
    expect(stripBox.x).toBeGreaterThanOrEqual(0);
    expect(auditBox.x).toBeGreaterThanOrEqual(0);
    expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(auditBox.x + auditBox.width).toBeLessThanOrEqual(viewport.width + 1);
  }

  await page.locator(".active-review-decisions [data-decision='keep-current']").click();
  await expect(page.locator(".active-review-decisions [data-decision='keep-current']")).toHaveClass(/is-active/);
  await expect(page.getByTestId("session-event-list")).toContainText("decision-changed");
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
