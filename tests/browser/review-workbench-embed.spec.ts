/**
 * Browser cover for the EMBEDDED workbench: the packaged
 * `@kontourai/survey/review-workbench.css` linked by a host page that loads no
 * token layer of its own, mounted over an envelope-imported review queue.
 *
 * This is the surface the three downstream defects were found on, and none of
 * them were visible from the node suite: dead design tokens (kontourai/survey#202),
 * typed non-editable items that could never be decided (#201), and a "Leave unset"
 * control that threw and left the whole queue unrenderable (#203).
 */
import { expect, test, type Page } from "@playwright/test";

import { envelopeInspectorEntry, envelopeReviewQueueSession } from "../envelope-review-fixture.js";

const fixturePath = "/tests/browser/fixtures/review-workbench-embed.html";

interface LoadedEmbed {
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
}

async function loadEmbed(page: Page): Promise<LoadedEmbed> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const fixture = {
    session: JSON.parse(JSON.stringify(envelopeReviewQueueSession())),
    inspectorEntry: JSON.parse(JSON.stringify(envelopeInspectorEntry())),
  };
  await page.addInitScript((value) => {
    (window as unknown as Record<string, unknown>).__surveyEmbedFixture = value;
  }, fixture);

  await page.goto(fixturePath);
  await expect(page.getByTestId("review-fields")).toBeVisible();
  return { pageErrors, consoleErrors };
}

function fieldByTarget(page: Page, target: string) {
  return page.locator(`[data-testid="review-field"][data-field="${target}"]`);
}

test.describe("embedded workbench: design tokens", () => {
  test("every --k-* token resolves inside the embed, and the source highlight is actually painted", async ({ page }) => {
    const { pageErrors } = await loadEmbed(page);

    // kontourai/survey#202: the bundled CSS declared each token against itself
    // (`--k-brand: var(--k-brand, #5ce0c6)`), a custom-property cycle. Every
    // token computed to the empty string and the highlight painted nothing.
    const tokens = await page.evaluate(() => {
      const embed = document.querySelector<HTMLElement>(".survey-workbench-embed")!;
      const computed = window.getComputedStyle(embed);
      return Object.fromEntries(
        ["--k-brand", "--k-bg", "--k-panel", "--k-text", "--k-brand-wash", "--k-radius"]
          .map((name) => [name, computed.getPropertyValue(name).trim()]),
      );
    });
    for (const [name, value] of Object.entries(tokens)) {
      expect(value, `${name} must resolve inside .survey-workbench-embed`).not.toBe("");
    }

    const highlight = page.locator(".inspector-source mark").first();
    await expect(highlight).toBeVisible();
    const painted = await highlight.evaluate((node) => {
      const computed = window.getComputedStyle(node);
      return {
        backgroundColor: computed.backgroundColor,
        outlineStyle: computed.outlineStyle,
        outlineWidth: computed.outlineWidth,
      };
    });
    // Transparent fill AND no outline is exactly how the highlight shipped.
    expect(painted.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(painted.backgroundColor).not.toBe("transparent");
    expect(painted.outlineStyle).toBe("solid");
    expect(painted.outlineWidth).not.toBe("0px");

    expect(pageErrors).toEqual([]);
  });
});

test.describe("embedded workbench: source-highlight references", () => {
  test("every candidate's published highlightElementId resolves to its own highlight anchor", async ({ page }) => {
    const { pageErrors } = await loadEmbed(page);

    // The supported way for a host to link a fact to the sentence it came from.
    // A consumer that had to reconstruct these ids from Survey's private id
    // sanitizer shipped a copy of it and a test to catch it drifting
    // (kontourai/fieldwork#58); the id is published on the model instead, and
    // the renderer reads the same field, so the two cannot disagree.
    const resolution = await page.evaluate(() => {
      const model = (window as unknown as {
        __surveyInspectorModel: { candidates: Array<{ id: string; highlightElementId: string }> };
      }).__surveyInspectorModel;

      return model.candidates.map((candidate) => {
        const matches = document.querySelectorAll(`[id="${candidate.highlightElementId}"]`);
        const anchor = matches[0] as HTMLElement | undefined;
        return {
          candidateId: candidate.id,
          highlightElementId: candidate.highlightElementId,
          matchCount: matches.length,
          boundTo: anchor?.dataset.highlightCandidateId ?? null,
          isHighlightAnchor: anchor?.classList.contains("highlight-anchor") ?? false,
        };
      });
    });

    expect(resolution.length).toBeGreaterThan(0);
    for (const entry of resolution) {
      expect(entry.matchCount, `${entry.highlightElementId} must resolve to exactly one element`).toBe(1);
      expect(entry.isHighlightAnchor).toBe(true);
      // Resolving is not enough: it has to be THIS candidate's sentence.
      expect(entry.boundTo).toBe(entry.candidateId);
    }

    expect(pageErrors).toEqual([]);
  });
});

test.describe("embedded workbench: host theming", () => {
  test("a host re-brands the embed by declaring tokens on the embed element", async ({ page }) => {
    const { pageErrors } = await loadEmbed(page);

    // The documented light-DOM override path (docs/consumer-integration-guide.md,
    // "Where the override has to go"). The embed carries .theme-survey here, so the
    // host rule has to clear the preset selectors' specificity.
    await page.addStyleTag({
      content: ".survey-workbench-embed[class][class][class] { --k-brand: rgb(255, 0, 128); }",
    });
    const chipColor = await page
      .locator(".chip.review")
      .first()
      .evaluate((node) => window.getComputedStyle(node).color);
    expect(chipColor).toBe("rgb(255, 0, 128)");

    expect(pageErrors).toEqual([]);
  });
});

test.describe("embedded workbench: envelope-imported decisions", () => {
  test("Use proposed decides a string, number, date, and enum item alike", async ({ page }) => {
    const { pageErrors, consoleErrors } = await loadEmbed(page);

    // kontourai/survey#201: number and date items were permanently inert because
    // the handler validated an editor a non-editable item never renders — and the
    // error slot it wrote into lives inside that suppressed editor, so the
    // reviewer saw no reason either.
    for (const target of ["vendor.name", "commercial.annualFeeUsd", "renewal.date", "renewal.posture"]) {
      const field = fieldByTarget(page, target);
      await expect(field.getByTestId("edit-proposed-value")).toHaveCount(0);
      await field.getByTestId("use-proposed").click();
      await expect(field).toHaveAttribute("data-decision", "accept-proposed");
      await expect(field.getByTestId("decided-chip")).toHaveText("Accepted");
    }

    await expect(page.getByTestId("decided-count")).toHaveText("4");
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("Leave unset records a decision instead of throwing, and the queue keeps updating", async ({ page }) => {
    const { pageErrors, consoleErrors } = await loadEmbed(page);
    const unset = fieldByTarget(page, "commercial.annualFeeUsd");

    // kontourai/survey#203: this control is labelled "Leave unset" for an item
    // with no current value, but was routed at keep-current — a candidate role
    // the item does not carry. It threw after the session had already been
    // mutated, so every later render of the queue threw too.
    await expect(unset.getByTestId("keep-current")).toHaveText("Leave unset");
    await unset.getByTestId("keep-current").click();

    await expect(unset).toHaveAttribute("data-decision", "reject-proposed");
    await expect(unset.getByTestId("decided-chip")).toHaveText("Left unset");

    // A different card must still respond — the poisoned session used to freeze
    // the whole queue after one click.
    const other = fieldByTarget(page, "renewal.date");
    await other.getByTestId("use-proposed").click();
    await expect(other.getByTestId("decided-chip")).toHaveText("Accepted");
    await expect(page.getByTestId("decided-count")).toHaveText("2");

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("Could not confirm records a reasoned non-answer on an envelope-imported item", async ({ page }) => {
    const { pageErrors, consoleErrors } = await loadEmbed(page);
    const field = fieldByTarget(page, "renewal.posture");

    await field.getByTestId("audit-details").locator("summary").first().click();
    await field.getByTestId("reviewer-note").fill("Source page was unreadable.");
    await field.getByTestId("could-not-confirm").click();

    await expect(field).toHaveAttribute("data-decision", "could-not-confirm");
    await expect(field.getByTestId("decided-chip")).toHaveText("Could not confirm");

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("the decided count is not painted over by a host's generic .progress styles", async ({ page }) => {
    const { pageErrors } = await loadEmbed(page);

    // @kontourai/ui ships an unscoped `.progress span { background: linear-gradient(...) }`.
    // The embed's decided count is a <span> inside .progress, and the embed styled
    // no rule for it, so a host that loads the kit painted a gradient over the text.
    await page.addStyleTag({
      content: ".progress { height: 8px; } .progress span { display: block; height: 100%; background: linear-gradient(90deg, #5ce0c6, #7aa2ff); }",
    });
    const ptext = page.locator(".progress .ptext");
    const painted = await ptext.evaluate((node) => window.getComputedStyle(node).backgroundImage);
    expect(painted).toBe("none");
    await expect(page.getByTestId("decided-count")).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
