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

import {
  envelopeInspectorEntry,
  envelopeReviewQueueSession,
  paginatingEnvelopeSeeds,
} from "../envelope-review-fixture.js";

const fixturePath = "/tests/browser/fixtures/review-workbench-embed.html";

interface LoadedEmbed {
  readonly pageErrors: string[];
  readonly consoleErrors: string[];
}

interface EmbedOptions {
  /** Seed count and page size, to mount a queue that actually paginates. */
  readonly candidates?: number;
  readonly pageSize?: number;
  /** Overrides the resolved artifact, to mount a non-grounded posture. */
  readonly artifact?: unknown;
  /** Mounts the pre-2.3.0 authoring shape: a model carrying no DOM bindings. */
  readonly stripPublishedHighlightIds?: boolean;
  /** Mounts a published id and a derived one that would collide with it. */
  readonly collidingHighlightIds?: boolean;
  /** Mounts a hand-authored model whose candidate ids are not unique. */
  readonly duplicateCandidateIds?: boolean;
}

async function loadEmbed(page: Page, options: EmbedOptions = {}): Promise<LoadedEmbed> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const seeds = options.candidates ? paginatingEnvelopeSeeds(options.candidates) : undefined;
  const inspectorEntry = seeds ? envelopeInspectorEntry(seeds) : envelopeInspectorEntry();
  const fixture = {
    session: JSON.parse(JSON.stringify(seeds ? envelopeReviewQueueSession(seeds) : envelopeReviewQueueSession())),
    inspectorEntry: JSON.parse(JSON.stringify(options.artifact ? { ...inspectorEntry, artifact: options.artifact } : inspectorEntry)),
    ...(options.pageSize ? { inspectorPageSize: options.pageSize } : {}),
    ...(options.stripPublishedHighlightIds ? { stripPublishedHighlightIds: true } : {}),
    ...(options.collidingHighlightIds ? { collidingHighlightIds: true } : {}),
    ...(options.duplicateCandidateIds ? { duplicateCandidateIds: true } : {}),
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
  /** Reads every published id and how many elements it resolves to, right now. */
  const resolvePublishedIds = (page: Page) => page.evaluate(() => {
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

  const expectAllResolve = (
    resolution: Awaited<ReturnType<typeof resolvePublishedIds>>,
    expectedCount: number,
  ) => {
    expect(resolution).toHaveLength(expectedCount);
    for (const entry of resolution) {
      expect(entry.matchCount, `${entry.highlightElementId} must resolve to exactly one element`).toBe(1);
      expect(entry.isHighlightAnchor).toBe(true);
      // Resolving is not enough: it has to be THIS candidate's sentence.
      expect(entry.boundTo).toBe(entry.candidateId);
    }
  };

  test("every candidate's published highlightElementId resolves to its own highlight anchor", async ({ page }) => {
    const { pageErrors } = await loadEmbed(page);

    // The supported way for a host to link a fact to the sentence it came from.
    // A consumer that had to reconstruct these ids from Survey's private id
    // sanitizer shipped a copy of it and a test to catch it drifting
    // (kontourai/fieldwork#58); the id is published on the model instead, and
    // the renderer reads the same field, so the two cannot disagree.
    expectAllResolve(await resolvePublishedIds(page), 4);

    expect(pageErrors).toEqual([]);
  });

  test("published ids still resolve for candidates that are off the mounted page or filtered out", async ({ page }) => {
    // 12 candidates over pages of 5. Two thirds of the model is off-page on
    // arrival, which is the condition a 204-candidate model reaches against the
    // default page size of 100 — a host's href would have pointed at nothing.
    const { pageErrors } = await loadEmbed(page, { candidates: 12, pageSize: 5 });

    const rows = page.locator(".inspector-candidate");
    await expect(rows).toHaveCount(5);
    expectAllResolve(await resolvePublishedIds(page), 12);

    // Paging does not take the other pages' anchors away with it.
    await page.locator('[data-page="next"]').click();
    await expect(rows).toHaveCount(5);
    expectAllResolve(await resolvePublishedIds(page), 12);

    // Neither does filtering the list down to one row.
    await page.locator('input[data-filter="query"]').fill("LineItem07");
    await expect(rows).toHaveCount(1);
    expectAllResolve(await resolvePublishedIds(page), 12);

    expect(pageErrors).toEqual([]);
  });

  // The postures where there is no prepared text to highlight. The model still
  // publishes an id for every candidate, so the anchor has to exist or the
  // host's href lands nowhere — the same defect as paging them away, in the one
  // place a reviewer most needs to be told WHY there is nothing to see. Node
  // cover for these postures existed at model level only, which is how the
  // mounted case survived.
  const NON_GROUNDED = [
    { name: "an unavailable prepared artifact", artifact: { status: "unavailable", code: "storage-error" } },
    { name: "a digest-mismatched prepared artifact", artifact: { status: "digest-mismatch", actualDigest: "0".repeat(64) } },
    { name: "a tampered prepared artifact", artifact: { status: "available", text: "tampered beyond recognition", actualDigest: "0".repeat(64) } },
  ];

  for (const posture of NON_GROUNDED) {
    test(`published ids still resolve with ${posture.name}`, async ({ page }) => {
      const { pageErrors } = await loadEmbed(page, { artifact: posture.artifact });

      // The posture itself must actually be non-grounded, or this proves nothing.
      await expect(page.locator(".source-unavailable")).toHaveCount(1);
      await expect(page.locator(".inspector-source mark")).toHaveCount(0);

      expectAllResolve(await resolvePublishedIds(page), 4);

      // Nothing is painted to return from, so nothing claims to be a control.
      await expect(page.locator(".inspector-source [role='button']")).toHaveCount(0);

      expect(pageErrors).toEqual([]);
    });
  }

  test("only the anchors scale with the model; rows and painted highlights stay bounded by pageSize", async ({ page }) => {
    // Mounting an anchor per candidate is what makes the published id resolve
    // unconditionally, so the cost of that decision needs a guard. 600
    // candidates against the default page size of 100: every id resolves, and
    // the two expensive things — candidate rows and <mark> painting — stay at
    // one page. Measured alongside this: ~1 extra element per off-page
    // candidate and no mount-time regression (193ms at 600 vs 197ms at 100).
    const { pageErrors } = await loadEmbed(page, { candidates: 600 });

    await expect(page.locator(".highlight-anchor")).toHaveCount(600);
    await expect(page.locator(".inspector-candidate")).toHaveCount(100);
    await expect(page.locator(".inspector-source mark")).toHaveCount(100);
    expectAllResolve(await resolvePublishedIds(page), 600);

    expect(pageErrors).toEqual([]);
  });

  test("link targets are inert: no tab stops, no pointer target, nothing painted", async ({ page }) => {
    // There is one of these per candidate in the model, which is what makes the
    // published id resolve unconditionally — so it has to cost a keyboard or
    // screen-reader user nothing. As a <button> it did: 600 candidates put 600
    // invisible tab stops in sequence, several stacked together here.
    const { pageErrors } = await loadEmbed(page, { artifact: { status: "unavailable", code: "storage-error" } });

    const anchors = page.locator(".highlight-anchor");
    await expect(anchors).toHaveCount(4);

    const shape = await anchors.first().evaluate((node) => {
      const box = node.getBoundingClientRect();
      const computed = window.getComputedStyle(node);
      return {
        tag: node.tagName,
        tabIndex: (node as HTMLElement).tabIndex,
        role: node.getAttribute("role"),
        width: box.width,
        borderTopWidth: computed.borderTopWidth,
        backgroundImage: computed.backgroundImage,
        text: node.textContent,
      };
    });
    expect(shape.tag).toBe("SPAN");
    expect(shape.tabIndex).toBe(-1);
    expect(shape.role).toBeNull();
    expect(shape.width).toBe(0);
    expect(shape.borderTopWidth).toBe("0px");
    expect(shape.backgroundImage).toBe("none");
    expect(shape.text).toBe("");

    expect(pageErrors).toEqual([]);
  });

  test("the painted highlight is the return control, and tab stops stay bounded by the page", async ({ page }) => {
    // 600 candidates, page size 100. Link targets scale with the model; the
    // thing a reader can see and aim at does not.
    const { pageErrors } = await loadEmbed(page, { candidates: 600 });

    await expect(page.locator(".highlight-anchor")).toHaveCount(600);
    const marks = page.locator(".inspector-source mark");
    await expect(marks).toHaveCount(100);

    // One tab stop per painted highlight. The source <pre> is itself focusable
    // so the prepared text is reachable; nothing else in here is.
    const focusable = await page.evaluate(() =>
      [...document.querySelectorAll(".inspector-source [tabindex='0'], .inspector-source button, .inspector-source a[href]")]
        .map((node) => node.tagName.toLowerCase()),
    );
    expect(focusable.filter((tag) => tag === "mark")).toHaveLength(100);
    expect(focusable.filter((tag) => tag !== "mark")).toEqual(["pre"]);

    // Full phrase width, not a sliver, and visibly marked already. Every target
    // clears 24x24 (WCAG 2.5.8) on its own rather than leaning on the inline
    // exception, and none of them overlap — the vertical padding that buys the
    // height is inside the line box the prepared text's line-height provides.
    const targets = await marks.evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
    }));
    expect(Math.min(...targets.map((t) => t.height))).toBeGreaterThanOrEqual(24);
    expect(Math.min(...targets.map((t) => t.width))).toBeGreaterThanOrEqual(24);
    let overlaps = 0;
    for (let i = 0; i < targets.length; i += 1) {
      for (let j = i + 1; j < targets.length; j += 1) {
        const a = targets[i]!, b = targets[j]!;
        if (a.top < b.bottom && b.top < a.bottom && a.left < b.right && b.left < a.right) overlaps += 1;
      }
    }
    expect(overlaps).toBe(0);

    const first = marks.first();
    await expect(first).toHaveAttribute("role", "button");
    await expect(first).toHaveAttribute("aria-label", /activate to return to candidate/i);

    expect(pageErrors).toEqual([]);
  });

  test("activating a painted highlight returns focus to its candidate row", async ({ page }) => {
    const { pageErrors } = await loadEmbed(page);

    const mark = page.locator(".inspector-source mark").first();
    const candidateId = await mark.getAttribute("data-highlight-return-to");
    await mark.click();

    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return { candidateId: active?.dataset.candidateId ?? null, isCandidateRow: active?.classList.contains("inspector-candidate") ?? false };
    });
    expect(focused.isCandidateRow).toBe(true);
    expect(focused.candidateId).toBe(candidateId);

    expect(pageErrors).toEqual([]);
  });

  test("a derived id never collides with one a host is already linking to", async ({ page }) => {
    // The uniqueness check compared the bare token against a set of finished
    // element ids, so a published `highlight-beta-two` did not stop a candidate
    // whose id sanitizes to `beta-two` from deriving the same element id. Both
    // mounted under it and a host's href resolved to whichever came first —
    // collision-freedom being the whole argument for publishing a resolved value.
    const { pageErrors } = await loadEmbed(page, { collidingHighlightIds: true });

    const ids = await page.locator(".highlight-anchor").evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);

    // The published id still resolves, to exactly one element, and it is the
    // candidate that published it — a published id is used verbatim.
    await expect(page.locator('[id="highlight-beta-two"]')).toHaveCount(1);
    expect(ids).toContain("highlight-beta-two");
    const publishedOwner = await page.locator('[id="highlight-beta-two"]').getAttribute("data-highlight-candidate-id");
    expect(publishedOwner).toBe("alpha-one");

    expect(pageErrors).toEqual([]);
  });

  test("a published id survives a hand-authored model whose candidate ids are not unique", async ({ page }) => {
    // Resolution used to be keyed on candidate.id. The builder's ids are
    // structurally unique so that looked safe, but this function exists FOR
    // models a caller assembled, where nothing enforces it — and two candidates
    // sharing an id collapsed into one entry, handing the second's derived id to
    // the first and discarding the published id a host was already linking to.
    const { pageErrors } = await loadEmbed(page, { duplicateCandidateIds: true });

    const ids = await page.locator(".highlight-anchor").evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    // The host's link still works, and still points at the candidate that published it.
    await expect(page.locator('[id="highlight-published-first"]')).toHaveCount(1);

    expect(pageErrors).toEqual([]);
  });

  test("a hand-authored model with no published ids still mounts, with anchors resolved for it", async ({ page }) => {
    // `ExtractionInspectorModel` is also the shape a caller may assemble and
    // pass to mount, which is why the binding is optional there and required
    // only on what the builder returns. Mount fills in what is missing instead
    // of refusing to render — the alternative was type-breaking that authoring
    // path on a minor release.
    const { pageErrors } = await loadEmbed(page, { stripPublishedHighlightIds: true });

    const anchors = page.locator(".highlight-anchor");
    await expect(anchors).toHaveCount(4);
    const ids = await anchors.evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(ids.filter(Boolean)).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);

    expect(pageErrors).toEqual([]);
  });

  test("following a host's href to an off-page candidate pages to it and paints its highlight", async ({ page }) => {
    // This is what `href="#<highlightElementId>"` does. The anchor always
    // resolves, but a candidate off the page or excluded by a filter has no
    // painted highlight, so the link alone would drop the reader on an invisible
    // marker in the middle of the source text.
    const { pageErrors } = await loadEmbed(page, { candidates: 12, pageSize: 5 });

    await page.locator('input[data-filter="query"]').fill("LineItem00");
    await expect(page.locator(".inspector-candidate")).toHaveCount(1);

    const offPage = await page.evaluate(() => {
      const model = (window as unknown as {
        __surveyInspectorModel: { candidates: Array<{ id: string; highlightElementId: string; field: string }> };
      }).__surveyInspectorModel;
      return model.candidates.find((candidate) => candidate.field === "line.item09")!;
    });

    await page.evaluate((id) => { window.location.hash = `#${id}`; }, offPage.highlightElementId);

    const mark = page.locator(`[data-highlight-return-to="${offPage.id}"]`);
    await expect(mark).toBeVisible();
    await expect(mark).toBeFocused();

    // And from there the highlight returns to its candidate row.
    await page.keyboard.press("Enter");
    const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.candidateId ?? null);
    expect(focused).toBe(offPage.id);

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
