/**
 * Browser integration spec for the <survey-review-workbench> custom element.
 *
 * Tests cover the self-contained single-import boot contract: a page imports
 * only the compiled element module and the element renders a full workbench
 * with embedded CSS — no external stylesheet required.
 *
 * Playwright's CSS locators automatically pierce shadow DOM boundaries, so
 * page.locator() and page.getByTestId() work against shadow-root content.
 */

import { expect, test, type Page } from "@playwright/test";

const FIXTURE_PATH = "/tests/browser/fixtures/review-workbench-element.html";

// ---------------------------------------------------------------------------
// Minimal session fixture (ReviewQueueSessionState shape) inlined so the
// tests have no filesystem dependency.
// ---------------------------------------------------------------------------
const SESSION_FIXTURE = {
  items: [
    {
      apiVersion: "survey.kontourai.io/v1alpha1",
      kind: "ReviewItem",
      metadata: {
        name: "element-spec-hours",
        producer: { displayName: "Element Spec Program" },
      },
      spec: {
        target: "hours",
        candidateSetStatus: "needs-review",
        candidates: [
          {
            id: "element-spec-hours:current",
            role: "current",
            value: "Weekdays 9am-5pm",
            confidence: 0.91,
            source: {
              sourceRef: "https://example.test/element-spec",
              kind: "web-page",
              observedAt: "2026-06-04T00:00:00.000Z",
            },
            locator: {
              scheme: "html",
              locator: "html:field=hours",
              excerpt: "Hours for element spec.",
            },
            extraction: {
              target: "hours",
              confidence: 0.91,
              extractor: "element-spec-extractor",
              extractedAt: "2026-06-04T00:00:00.000Z",
            },
            claimTarget: {
              claimId: "element-spec.hours.current",
              subjectType: "test",
              subjectId: "test-entity",
              facet: "test",
              claimType: "test",
              fieldOrBehavior: "hours",
              impactLevel: "low",
            },
          },
          {
            id: "element-spec-hours:proposed",
            role: "proposed",
            value: "Weekdays 8am-6pm",
            confidence: 0.82,
            source: {
              sourceRef: "https://example.test/element-spec-proposed",
              kind: "web-page",
              observedAt: "2026-06-04T01:00:00.000Z",
            },
            locator: {
              scheme: "html",
              locator: "html:field=hours",
              excerpt: "Updated hours for element spec.",
            },
            extraction: {
              target: "hours",
              confidence: 0.82,
              extractor: "element-spec-crawler",
              extractedAt: "2026-06-04T01:00:00.000Z",
            },
            claimTarget: {
              claimId: "element-spec.hours.proposed",
              subjectType: "test",
              subjectId: "test-entity",
              facet: "test",
              claimType: "test",
              fieldOrBehavior: "hours",
              impactLevel: "low",
            },
          },
        ],
      },
      status: { observedCandidateCount: 2 },
    },
    {
      apiVersion: "survey.kontourai.io/v1alpha1",
      kind: "ReviewItem",
      metadata: {
        name: "element-spec-phone",
        producer: { displayName: "Element Spec Program" },
      },
      spec: {
        target: "phoneNumber",
        candidateSetStatus: "needs-review",
        candidates: [
          {
            id: "element-spec-phone:current",
            role: "current",
            value: "+1-555-0100",
            confidence: 0.9,
            source: {
              sourceRef: "https://example.test/element-spec",
              kind: "web-page",
              observedAt: "2026-06-04T00:00:00.000Z",
            },
            locator: { scheme: "html", locator: "html:field=phone", excerpt: "Phone for spec." },
            extraction: {
              target: "phoneNumber",
              confidence: 0.9,
              extractor: "element-spec-extractor",
              extractedAt: "2026-06-04T00:00:00.000Z",
            },
            claimTarget: {
              claimId: "element-spec.phone.current",
              subjectType: "test",
              subjectId: "test-entity",
              facet: "test",
              claimType: "test",
              fieldOrBehavior: "phoneNumber",
              impactLevel: "low",
            },
          },
          {
            id: "element-spec-phone:proposed",
            role: "proposed",
            value: "+1-555-0199",
            confidence: 0.8,
            source: {
              sourceRef: "https://example.test/element-spec-proposed",
              kind: "web-page",
              observedAt: "2026-06-04T01:00:00.000Z",
            },
            locator: { scheme: "html", locator: "html:field=phone", excerpt: "Updated phone." },
            extraction: {
              target: "phoneNumber",
              confidence: 0.8,
              extractor: "element-spec-crawler",
              extractedAt: "2026-06-04T01:00:00.000Z",
            },
            claimTarget: {
              claimId: "element-spec.phone.proposed",
              subjectType: "test",
              subjectId: "test-entity",
              facet: "test",
              claimType: "test",
              fieldOrBehavior: "phoneNumber",
              impactLevel: "low",
            },
          },
        ],
      },
      status: { observedCandidateCount: 2 },
    },
  ],
  activeItemName: "element-spec-hours",
  notesByItemName: {},
  decisionsByItemName: {},
  reviewedAt: "2026-06-04T00:00:00.000Z",
  actorId: "element-spec-operator",
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ErrorCollectors {
  /** Browser console "error" messages (includes network "Failed to load resource" lines). */
  consoleErrors: string[];
  /** Uncaught JS exceptions — these must always be empty. */
  pageErrors: string[];
}

/**
 * Navigate to the element fixture and wire error collectors.
 * consoleErrors contains all console.error / browser-network error lines.
 * pageErrors contains only uncaught JS exceptions — these must always be empty.
 */
async function loadFixture(page: Page): Promise<ErrorCollectors> {
  const collectors: ErrorCollectors = { consoleErrors: [], pageErrors: [] };
  page.on("console", (msg) => {
    if (msg.type() === "error") collectors.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    collectors.pageErrors.push(err.message);
  });
  await page.goto(FIXTURE_PATH);
  // Wait for the custom element class to be registered
  await page.waitForFunction(() =>
    typeof customElements !== "undefined" && customElements.get("survey-review-workbench") !== undefined,
  );
  return collectors;
}

/**
 * Assign a session to the element via the JS property and wait for the
 * workbench shell to appear in the shadow DOM.
 */
async function assignSession(page: Page, session: unknown): Promise<void> {
  await page.evaluate((s) => {
    const el = document.getElementById("wbe") as HTMLElement & { session: unknown };
    el.session = s;
  }, session);
  await page.locator(".workbench-shell").waitFor({ state: "visible" });
}

// ---------------------------------------------------------------------------
// TEST 1: SINGLE-IMPORT BOOT
// ---------------------------------------------------------------------------

test.describe("SINGLE-IMPORT BOOT: element self-contained module import", () => {
  test("shadow DOM renders queue and review content with styles applied", async ({ page }) => {
    const { consoleErrors, pageErrors } = await loadFixture(page);

    await assignSession(page, SESSION_FIXTURE);

    // Field cards render inside shadow DOM (Playwright pierces shadow boundary)
    await expect(page.locator("[data-testid='review-fields']")).toBeVisible();

    // The first field card renders its current/proposed candidate values
    const hoursField = page.locator("[data-testid='review-field'][data-item-name='element-spec-hours']");
    await expect(hoursField.getByTestId("current-value")).toContainText("Weekdays 9am-5pm");
    await expect(hoursField.getByTestId("proposed-value")).toContainText("Weekdays 8am-6pm");

    // Both fields render as field cards
    await expect(page.locator("[data-testid='review-field']")).toHaveCount(2);

    // The embedded CSS is applied — the .eyebrow selector gets `color: var(--k-faint)`.
    // If the CSS were not attached the element would be black (rgb(0,0,0)) — the default.
    const eyebrowColor: string = await page.evaluate(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return "";
      const eyebrow = host.shadowRoot.querySelector<HTMLElement>(".eyebrow");
      return eyebrow ? window.getComputedStyle(eyebrow).color : "";
    });

    // A non-empty, non-black color proves the embedded CSS was attached and
    // CSS custom properties resolved through the shadow DOM.
    expect(eyebrowColor).not.toBe("");
    expect(eyebrowColor).not.toBe("rgb(0, 0, 0)");

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TEST 2: SRC ATTRIBUTE
// ---------------------------------------------------------------------------

test.describe("SRC ATTRIBUTE: element loads session from URL", () => {
  test("src= loads session JSON and renders content", async ({ page }) => {
    const { consoleErrors, pageErrors } = await loadFixture(page);

    // Intercept the session JSON request and serve the fixture
    await page.route("**/element-spec-session.json", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION_FIXTURE),
      });
    });

    await page.evaluate(() => {
      const el = document.getElementById("wbe")!;
      el.setAttribute("src", "/element-spec-session.json");
    });

    await page.locator(".workbench-shell").waitFor({ state: "visible" });
    const hoursField = page.locator("[data-testid='review-field'][data-item-name='element-spec-hours']");
    await expect(hoursField.getByTestId("current-value")).toContainText("Weekdays 9am-5pm");
    await expect(page.locator("[data-testid='review-fields']")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("src= pointing at 404 shows workbench-error state with no JS exceptions", async ({ page }) => {
    const { pageErrors } = await loadFixture(page);

    // Route the 404 explicitly
    await page.route("**/nonexistent-session.json", async (route) => {
      await route.fulfill({ status: 404, body: "Not Found" });
    });

    await page.evaluate(() => {
      const el = document.getElementById("wbe")!;
      el.setAttribute("src", "/nonexistent-session.json");
    });

    // The error div is inside the shadow DOM; Playwright CSS piercing finds it
    await page.locator(".workbench-error").waitFor({ state: "visible" });
    await expect(page.locator(".workbench-error")).toContainText("404");

    // The browser emits a "Failed to load resource" console message for failed
    // fetch requests — that is expected browser behavior, not a JS exception.
    // Assert no *uncaught JS exceptions* escaped the element's error handler.
    expect(pageErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TEST 3: EMPTY STATE
// ---------------------------------------------------------------------------

test.describe("EMPTY STATE: element with no session or src", () => {
  test("shows the empty state when no session or src is provided", async ({ page }) => {
    const { consoleErrors, pageErrors } = await loadFixture(page);

    // Without assigning a session or setting src the element shows empty state
    await page.locator(".workbench-empty").waitFor({ state: "visible" });
    await expect(page.locator(".workbench-empty")).toContainText("No review session loaded yet.");

    // No workbench content should be rendered
    await expect(page.locator(".workbench-shell")).not.toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TEST 4: THEME PIERCING
// ---------------------------------------------------------------------------

test.describe("THEME PIERCING: host CSS custom properties reach shadow DOM", () => {
  test("overriding --k-brand and --k-positive on the host changes computed colors inside shadow DOM", async ({ page }) => {
    const { consoleErrors, pageErrors } = await loadFixture(page);

    await assignSession(page, SESSION_FIXTURE);

    // Capture the baseline "Needs review" chip color — .chip.review uses
    // `color: var(--k-brand)` directly (both fixture items are undecided).
    const baselineChipColor: string = await page.evaluate(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return "";
      const el = host.shadowRoot.querySelector<HTMLElement>(".chip.review");
      return el ? window.getComputedStyle(el).color : "";
    });
    expect(baselineChipColor).not.toBe("");

    // Override --k-brand and --k-positive on the host element.
    // CSS custom properties inherit through shadow DOM boundaries, so the
    // shadow-internal `.chip.review { color: var(--k-brand) }` rule picks up the
    // override. The inline style on the host has higher specificity than the
    // :host block and the .survey-workbench-embed block inside the shadow.
    await page.evaluate(() => {
      const host = document.getElementById("wbe")!;
      host.style.setProperty("--k-brand", "rgb(255, 0, 128)");
      host.style.setProperty("--k-positive", "rgb(0, 200, 100)");
    });

    // Wait until the computed color of the chip diverges from the baseline,
    // indicating the shadow DOM has processed the custom-property inheritance.
    await page.waitForFunction(
      (baseline) => {
        const host = document.getElementById("wbe");
        if (!host?.shadowRoot) return false;
        const el = host.shadowRoot.querySelector<HTMLElement>(".chip.review");
        return el ? window.getComputedStyle(el).color !== baseline : false;
      },
      baselineChipColor,
    );

    const overriddenChipColor: string = await page.evaluate(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return "";
      const el = host.shadowRoot.querySelector<HTMLElement>(".chip.review");
      return el ? window.getComputedStyle(el).color : "";
    });

    // The overridden color must differ from baseline and match our injected value,
    // proving --k-brand inherited through the shadow boundary.
    expect(overriddenChipColor).not.toBe(baselineChipColor);
    expect(overriddenChipColor).toBe("rgb(255, 0, 128)");

    // Also verify --k-positive piercing by reading the resolved custom property
    // value on the shadow-internal embed root.
    const resolvedKPositive: string = await page.evaluate(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return "";
      const embed = host.shadowRoot.querySelector<HTMLElement>(".survey-workbench-embed");
      return embed ? window.getComputedStyle(embed).getPropertyValue("--k-positive").trim() : "";
    });
    expect(resolvedKPositive).toBe("rgb(0, 200, 100)");

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TEST 5: HOSTILE INPUT
// ---------------------------------------------------------------------------

const HOSTILE_SCRIPT_INJECTION = "</script><script>window.__pwned=1</script>";
const HOSTILE_IMG_INJECTION = '<img src=x onerror="window.__pwned=2">';

const HOSTILE_SESSION = {
  items: [
    {
      apiVersion: "survey.kontourai.io/v1alpha1",
      kind: "ReviewItem",
      metadata: {
        name: "hostile-item",
        producer: { displayName: HOSTILE_SCRIPT_INJECTION },
      },
      spec: {
        target: HOSTILE_SCRIPT_INJECTION,
        candidateSetStatus: "needs-review",
        candidates: [
          {
            id: "hostile:current",
            role: "current",
            value: HOSTILE_IMG_INJECTION,
            confidence: 0.9,
            source: {
              sourceRef: HOSTILE_SCRIPT_INJECTION,
              kind: "web-page",
              observedAt: "2026-06-04T00:00:00.000Z",
            },
            locator: {
              scheme: "html",
              locator: "html:field=test",
              excerpt: HOSTILE_SCRIPT_INJECTION,
            },
            extraction: {
              target: "hostileField",
              confidence: 0.9,
              extractor: "test",
              extractedAt: "2026-06-04T00:00:00.000Z",
            },
            claimTarget: {
              claimId: "hostile.current",
              subjectType: "test",
              subjectId: "x",
              facet: "test",
              claimType: "test",
              fieldOrBehavior: "hostileField",
              impactLevel: "low",
            },
          },
          {
            id: "hostile:proposed",
            role: "proposed",
            value: HOSTILE_SCRIPT_INJECTION,
            confidence: 0.8,
            source: {
              sourceRef: HOSTILE_IMG_INJECTION,
              kind: "web-page",
              observedAt: "2026-06-04T01:00:00.000Z",
            },
            locator: {
              scheme: "html",
              locator: "html:field=test",
              excerpt: HOSTILE_IMG_INJECTION,
            },
            extraction: {
              target: "hostileField",
              confidence: 0.8,
              extractor: "test",
              extractedAt: "2026-06-04T01:00:00.000Z",
            },
            claimTarget: {
              claimId: "hostile.proposed",
              subjectType: "test",
              subjectId: "x",
              facet: "test",
              claimType: "test",
              fieldOrBehavior: "hostileField",
              impactLevel: "low",
            },
          },
        ],
      },
      status: { observedCandidateCount: 2 },
    },
  ],
  activeItemName: "hostile-item",
  notesByItemName: {},
  decisionsByItemName: {},
  reviewedAt: "2026-06-04T00:00:00.000Z",
  actorId: "test-operator",
};

test.describe("HOSTILE INPUT: XSS escaping in shadow DOM", () => {
  test("hostile strings in value/target/excerpt render as text — window.__pwned undefined, no injected elements", async ({ page }) => {
    const { consoleErrors, pageErrors } = await loadFixture(page);

    await assignSession(page, HOSTILE_SESSION);

    // window.__pwned must remain undefined — no XSS script executed
    const pwned = await page.evaluate(
      () => (window as unknown as Record<string, unknown>)["__pwned"],
    );
    expect(pwned).toBeUndefined();

    // No JS exceptions and no console errors (an onerror attribute firing would
    // generate a failed resource-load console error)
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);

    // No <img> elements injected into the shadow DOM from hostile value strings
    const imgCount = await page.evaluate(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return 0;
      return host.shadowRoot.querySelectorAll("img").length;
    });
    expect(imgCount).toBe(0);

    // The hostile string content appears as text in the shadow DOM (not markup)
    const shadowText = await page.evaluate(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return "";
      return host.shadowRoot.textContent ?? "";
    });

    // Both injection strings must appear as literal text, not as executed markup
    expect(shadowText).toContain("</script><script>window.__pwned=1</script>");
    expect(shadowText).toContain('<img src=x onerror="window.__pwned=2">');
  });
});

// ---------------------------------------------------------------------------
// TEST 6: LIGHT MODE RENDERING
// ---------------------------------------------------------------------------

test.describe("LIGHT MODE: color-scheme=light produces correct token flip", () => {
  test("setting color-scheme=light changes background and text contrast tokens in shadow DOM", async ({ page }) => {
    const { consoleErrors, pageErrors } = await loadFixture(page);

    await assignSession(page, SESSION_FIXTURE);

    // Capture dark-mode --k-bg and --k-text token values from the embed root.
    // These CSS custom property values are what drive all color decisions in the workbench.
    const darkTokens: { bg: string; text: string } = await page.evaluate(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return { bg: "", text: "" };
      const embed = host.shadowRoot.querySelector<HTMLElement>(".survey-workbench-embed");
      if (!embed) return { bg: "", text: "" };
      const styles = window.getComputedStyle(embed);
      return {
        bg: styles.getPropertyValue("--k-bg").trim(),
        text: styles.getPropertyValue("--k-text").trim(),
      };
    });
    // Dark mode tokens must be present and non-empty
    expect(darkTokens.bg).not.toBe("");
    expect(darkTokens.text).not.toBe("");

    // Switch to light mode by setting the color-scheme attribute
    await page.evaluate(() => {
      const el = document.getElementById("wbe")!;
      el.setAttribute("color-scheme", "light");
    });

    // Wait for the embed root to have data-theme="light"
    await page.waitForFunction(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return false;
      const embed = host.shadowRoot.querySelector(".survey-workbench-embed");
      return embed?.getAttribute("data-theme") === "light";
    });

    // Read the light-mode token values — they must have flipped
    const lightTokens: { bg: string; text: string } = await page.evaluate(() => {
      const host = document.getElementById("wbe");
      if (!host?.shadowRoot) return { bg: "", text: "" };
      const embed = host.shadowRoot.querySelector<HTMLElement>(".survey-workbench-embed");
      if (!embed) return { bg: "", text: "" };
      const styles = window.getComputedStyle(embed);
      return {
        bg: styles.getPropertyValue("--k-bg").trim(),
        text: styles.getPropertyValue("--k-text").trim(),
      };
    });

    // --k-bg must flip: dark mode is very dark (~#060a10), light mode is light (~#f5f4ef)
    expect(lightTokens.bg).not.toBe(darkTokens.bg);
    // --k-text must flip: dark mode is near-white (#eef3f8), light mode is near-black (#202124)
    expect(lightTokens.text).not.toBe(darkTokens.text);

    // No JS exceptions
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
