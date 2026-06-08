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
