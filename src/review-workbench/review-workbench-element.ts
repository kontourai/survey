/**
 * <survey-review-workbench> — Custom element wrapper for the Survey Review Workbench.
 *
 * Works like <surface-trust-panel>: data via the `.session` property OR a `src`
 * attribute that fetches a JSON-serialised ReviewQueueSessionState. Shadow DOM
 * is used throughout so CSS custom properties (--k-*) inherit from the host
 * with no separate stylesheet required — a single module import is sufficient.
 *
 * Usage (single import, self-contained):
 *   import "@kontourai/survey/review-workbench/element";
 *   <survey-review-workbench theme="survey" color-scheme="dark"
 *                             src="/api/sessions/my-session.json">
 *   </survey-review-workbench>
 *
 *   // or via property:
 *   const el = document.querySelector("survey-review-workbench");
 *   el.session = reviewQueueSession;
 *   el.presentationAdapter = myPresentationAdapter;
 *
 * Theming:
 *   CSS custom properties (--k-*) inherit through the shadow boundary.
 *   Setting any --k-* token on the element or an ancestor overrides the
 *   shadow :host defaults. Token defaults are declared on :host so that
 *   host-page rules always win over the shadow defaults.
 *
 * Attributes:
 *   theme       — "survey" | "console" | "flow" | "surface" (maps to a theme-* class
 *                 with its own brand colour) | "custom" (or any other value: no
 *                 theme-* class at all, so a host's own --k-* overrides apply with
 *                 nothing to fight — see the "Theming" section of
 *                 docs/consumer-integration-guide.md for a full host-brand example)
 *   color-scheme — "dark" | "light"  (default: "dark")
 *   src          — URL to fetch a JSON-serialised ReviewQueueSessionState
 */

import {
  mountReviewWorkbench,
  type ReviewQueueSessionState,
  type ReviewWorkbenchState,
  type MountReviewWorkbenchOptions,
} from "./review-workbench.js";
import type { ReviewPresentationAdapter } from "./review-presentation.js";
import type { ExtractionEnvelopeImport, ExtractionEnvelopeImportResult } from "../extraction-envelope.js";
import {
  buildExtractionInspectorModel,
  mountExtractionInspector,
  type ExtractionInspectorInput,
} from "./extraction-inspector.js";
import {
  REVIEW_WORKBENCH_CSS,
  REVIEW_WORKBENCH_DARK_TOKEN_DECLARATIONS,
  REVIEW_WORKBENCH_LIGHT_TOKEN_DECLARATIONS,
  REVIEW_WORKBENCH_THEME_TOKEN_DECLARATIONS,
} from "./review-workbench-css.generated.js";

/** @internal Field-diff card aliases (Theming section of
 *  docs/consumer-integration-guide.md), derived from the base tokens. Declared
 *  on :host only: a var() alias resolves on the element that declares it, and
 *  every mode and preset below also lands on :host, so the aliases always see
 *  the final base values there and the embed inherits the result. */
const DERIVED_TOKEN_DECLARATIONS = `  --k-muted: var(--k-text-muted);
  --k-faint: var(--k-text-faint);
  --k-raised: var(--k-panel-raised);
  --k-sunken: color-mix(in srgb, var(--k-bg) 55%, var(--k-panel) 45%);
  --k-brand-ink: var(--k-brand-contrast);
  --k-brand-wash: color-mix(in srgb, var(--k-brand) 14%, transparent);
  --k-positive-wash: var(--k-positive-soft);
  --k-caution-wash: var(--k-caution-soft);
  --k-negative-wash: var(--k-negative-soft);
  --k-radius: var(--k-radius-md);`;

/** @internal Token names the embed root inherits from :host: every base token
 *  :host always declares, plus the derived aliases. */
const INHERITED_TOKEN_NAMES = [
  ...`${REVIEW_WORKBENCH_DARK_TOKEN_DECLARATIONS}\n${DERIVED_TOKEN_DECLARATIONS}`.matchAll(/^\s*(--k-[\w-]+)\s*:/gm),
].map((match) => match[1]);

/** @internal Preset selectors per theme. A missing `theme` attribute renders as
 *  "survey" (see #applyThemeClasses), so it takes the survey preset too. */
function presetHostRules(theme: string, declarations: { readonly dark: string; readonly light: string }): string {
  const dark = theme === "survey" ? `:host(:not([theme])), :host([theme="survey"])` : `:host([theme="${theme}"])`;
  const light = theme === "survey"
    ? `:host(:not([theme])[color-scheme="light"]), :host([theme="survey"][color-scheme="light"])`
    : `:host([theme="${theme}"][color-scheme="light"])`;
  return `${dark} {\n${declarations.dark}\n}\n${light} {\n${declarations.light}\n}`;
}

/** @internal Token sheet: every --k-* value the workbench reads is decided on
 *  :host, and the embed root only inherits it.
 *
 * Adopted AFTER the main workbench CSS (adoptedStyleSheets[1]); appended after it
 * as a <style> where adoptedStyleSheets is unavailable.
 *
 * 1. :host carries the defaults, the light mode and the preset values, all as
 *    literals from @kontourai/ui (emitted by the CSS generator; never
 *    `var(--k-x, …)`, which would be a self-reference cycle). A declaration from
 *    the host document — the element's inline style, or any page rule targeting
 *    the element — beats every :host rule, whatever its specificity, so a host
 *    override of a base token or an alias wins in both modes and every preset.
 *    Values set on an ancestor of the element do not: the :host declaration
 *    beats inheritance.
 * 2. The embed root inherits those tokens from :host. The generated sheet also
 *    sets them on the embed (its scoped :root, [data-theme="light"] and
 *    [data-theme="light"].theme-* rules, up to (0,3,0)); `:host >` plus the
 *    doubled [class] lifts this rule to (0,4,0) so it wins regardless of order.
 */
const TOKEN_INHERIT_CSS = `:host {
  display: block;
  container-type: inline-size;
${REVIEW_WORKBENCH_DARK_TOKEN_DECLARATIONS}
${DERIVED_TOKEN_DECLARATIONS}
}
:host([color-scheme="light"]) {
  color-scheme: light;
${REVIEW_WORKBENCH_LIGHT_TOKEN_DECLARATIONS}
}
${Object.entries(REVIEW_WORKBENCH_THEME_TOKEN_DECLARATIONS).map(([theme, declarations]) => presetHostRules(theme, declarations)).join("\n")}
:host > .survey-workbench-embed[class][class] {
${INHERITED_TOKEN_NAMES.map((name) => `  ${name}: inherit;`).join("\n")}
}`;

/** The four built-in theme presets from vendor kontourai-ui/tokens/themes.css. Any
 *  other `theme` attribute value (including the documented `"custom"`) opts out of
 *  presets entirely — see {@link SurveyReviewWorkbenchElement.#applyThemeClasses}. */
const KNOWN_WORKBENCH_THEMES = new Set(["survey", "console", "flow", "surface"]);

export class SurveyReviewWorkbenchElement extends HTMLElement {
  static readonly observedAttributes = ["theme", "color-scheme", "src"];

  #session: ReviewQueueSessionState | ReviewWorkbenchState | null = null;
  #presentationAdapter: ReviewPresentationAdapter | undefined = undefined;
  #extractionInspector: ExtractionInspectorInput | null = null;
  #extractionImport: ExtractionEnvelopeImport | ExtractionEnvelopeImportResult | null = null;
  #unmountInspector: (() => void) | undefined;
  #root: ShadowRoot;
  #mountRoot: HTMLDivElement;
  #mounted = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });

    // Inject the workbench CSS directly from the generated module.
    // This makes the element fully self-contained: a single
    // `import "@kontourai/survey/review-workbench/element"` is all that's needed.
    const sheet = this.#adoptCss();
    if (!sheet) {
      // No adoptedStyleSheets: the same two sheets, in the same order, as <style>.
      for (const css of [REVIEW_WORKBENCH_CSS, TOKEN_INHERIT_CSS]) {
        const styleEl = document.createElement("style");
        styleEl.textContent = css;
        this.#root.appendChild(styleEl);
      }
    }

    const stateStyle = document.createElement("style");
    stateStyle.textContent = `
      .workbench-empty, .workbench-error {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 6rem;
        padding: 1.5rem;
        font-family: var(--k-font-ui);
        font-size: 0.9rem;
        color: var(--k-text-muted);
        background: var(--k-panel);
        border-radius: var(--k-radius-md);
      }
      .workbench-error {
        color: var(--k-negative);
      }
    `;
    this.#root.appendChild(stateStyle);

    this.#mountRoot = document.createElement("div");
    this.#mountRoot.className = "workbench survey-workbench-embed";
    this.#root.appendChild(this.#mountRoot);
    this.#mountRoot.addEventListener("survey-extraction-candidate-activate", (event) => {
      if (!this.#session || !("items" in this.#session)) return;
      const detail = (event as CustomEvent<{ candidateId: string; reviewItemName: string; highlightElementId?: string }>).detail;
      const item = this.#session.items.find((candidate) => candidate.metadata.name === detail.reviewItemName);
      if (!item) return;
      if (this.#session.activeItemName !== item.metadata.name) this.#session = { ...this.#session, activeItemName: item.metadata.name };
      this.#remount();
      // Both lookups below are published contracts, used as published.
      // Reconstructing the element id from candidateId — which this did — meant
      // carrying a copy of Survey's private id sanitizer and ignoring the
      // collision suffix that makes the id unique, which is exactly what the
      // consumer guide tells embedders not to do.
      const { highlightElementId } = detail;
      if (!highlightElementId) return;
      queueMicrotask(() => {
        // Routed on the highlight element id, which is unique by construction.
        // candidateId is the candidate's own identity and a caller-authored
        // model may repeat it, so a `[data-…="<candidateId>"]` lookup can select
        // a different candidate's highlight — confidently wrong, on the surface
        // whose job is showing which span a value came from. `~=` matches one
        // whitespace-separated token, so a mark over a shared span is found too.
        const highlight = this.#root.querySelector<HTMLElement>(`[data-highlight-return-to~="${CSS.escape(highlightElementId)}"]`);
        if (highlight) { highlight.focus(); return; }
        // Off the current page there is nothing painted; bring the link target
        // into view instead of leaving the reader where they were.
        this.#root.querySelector<HTMLElement>(`#${CSS.escape(highlightElementId)}`)?.scrollIntoView({ block: "center" });
      });
    });
  }

  /** The review queue session to display. Setting this property re-mounts the workbench. */
  get session(): ReviewQueueSessionState | ReviewWorkbenchState | null {
    return this.#session;
  }

  set session(value: ReviewQueueSessionState | ReviewWorkbenchState | null | undefined) {
    this.#session = value ?? null;
    this.#remount();
  }

  /** Optional presentation adapter for custom labels, value summaries, and links. */
  get presentationAdapter(): ReviewPresentationAdapter | undefined {
    return this.#presentationAdapter;
  }

  set presentationAdapter(value: ReviewPresentationAdapter | undefined) {
    this.#presentationAdapter = value;
    this.#remount();
  }

  /**
   * The extraction import record the queue was built from, as stored beside
   * it. The workbench checks the queue against it (see
   * `MountReviewWorkbenchOptions.extractionImport`). When unset, the import of
   * a single-import `extractionInspector` is used; with neither, a queue whose
   * items came from an extraction import shows an "Unverified queue" notice.
   */
  get extractionImport(): ExtractionEnvelopeImport | ExtractionEnvelopeImportResult | null { return this.#extractionImport; }

  set extractionImport(value: ExtractionEnvelopeImport | ExtractionEnvelopeImportResult | null | undefined) {
    this.#extractionImport = value ?? null;
    this.#remount();
  }

  /** Optional read-only source pane attached to this workbench's existing review lifecycle. */
  get extractionInspector(): ExtractionInspectorInput | null { return this.#extractionInspector; }

  set extractionInspector(value: ExtractionInspectorInput | null | undefined) {
    const next = value ?? null;
    try {
      if (next) buildExtractionInspectorModel(next);
      this.#extractionInspector = next;
      this.#remount();
    } catch {
      this.#extractionInspector = null;
      this.#renderError("Extraction inspector input is invalid and was not rendered.");
    }
  }

  connectedCallback(): void {
    // Rescue a `session` set before the element was upgraded so the property
    // assignment reaches the class accessor instead of being shadowed by an
    // own property. Mirrors the same pattern in <surface-trust-panel>.
    if (Object.prototype.hasOwnProperty.call(this, "session")) {
      const pending = (this as { session?: unknown }).session;
      delete (this as { session?: unknown }).session;
      this.session = pending as ReviewQueueSessionState | ReviewWorkbenchState | null | undefined;
      return;
    }

    this.#applyThemeClasses();

    const src = this.getAttribute("src");
    if (this.#session === null && src) {
      void this.#load(src);
    } else {
      this.#remount();
    }
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name === "src" && newValue && newValue !== oldValue) {
      void this.#load(newValue);
      return;
    }
    this.#applyThemeClasses();
  }

  async #load(src: string): Promise<void> {
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(`Failed to load session: HTTP ${response.status}`);
      this.session = await response.json() as ReviewQueueSessionState;
    } catch (error) {
      this.#renderError(error instanceof Error ? error.message : String(error));
    }
  }

  #applyThemeClasses(): void {
    const theme = this.getAttribute("theme") ?? "survey";
    const colorScheme = this.getAttribute("color-scheme") ?? "dark";
    // Only the four built-in presets get a `theme-*` class (see vendor
    // kontourai-ui/tokens/themes.css). `theme="custom"` — or any other value that
    // isn't one of the four presets — deliberately gets NO theme class, so none of
    // the presets' brand-colour overrides apply. This is the escape hatch for a
    // host that wants to set its own full `--k-*` palette (see the "Theming"
    // section of docs/consumer-integration-guide.md) without fighting a preset.
    const themeClass = KNOWN_WORKBENCH_THEMES.has(theme) ? ` theme-${theme}` : "";
    this.#mountRoot.className = `workbench survey-workbench-embed${themeClass}`;
    this.#mountRoot.setAttribute("data-color-scheme", colorScheme);
    // data-theme="light" is required by the token sheet for light mode token overrides.
    // data-dark is kept for any existing selectors that used it.
    if (colorScheme === "light") {
      this.#mountRoot.setAttribute("data-theme", "light");
      this.#mountRoot.removeAttribute("data-dark");
    } else {
      this.#mountRoot.removeAttribute("data-theme");
      this.#mountRoot.setAttribute("data-dark", "");
    }
  }

  #remount(): void {
    if (!this.isConnected) {
      return;
    }

    if (this.#session === null) {
      this.#renderEmpty();
      return;
    }

    const inspectorImport = this.#extractionInspector && !("imports" in this.#extractionInspector)
      ? this.#extractionInspector.importResult
      : undefined;
    const extractionImport = this.#extractionImport ?? inspectorImport;
    const options: MountReviewWorkbenchOptions = {
      ...(this.#presentationAdapter ? { presentationAdapter: this.#presentationAdapter } : {}),
      ...(extractionImport ? { extractionImport } : {}),
    };

    this.#applyThemeClasses();
    mountReviewWorkbench(this.#mountRoot, this.#session, options);
    this.#unmountInspector?.();
    this.#unmountInspector = this.#extractionInspector
      ? mountExtractionInspector(this.#mountRoot, buildExtractionInspectorModel(this.#extractionInspector))
      : undefined;
    this.#mounted = true;
  }

  #renderEmpty(): void {
    this.#mountRoot.innerHTML = '<div class="workbench-empty">No review session loaded yet.</div>';
    this.#mounted = false;
  }

  #renderError(message: string): void {
    this.#mountRoot.innerHTML = `<div class="workbench-error">${escapeHtml(message)}</div>`;
    this.#mounted = false;
  }

  /** Attempt to inject the workbench CSS via constructable CSSStyleSheet.
   *
   * Two sheets are adopted: the main workbench CSS first, then the token sheet
   * (TOKEN_INHERIT_CSS), which decides every --k-* token on :host and makes the
   * embed root inherit it, so host-document overrides on the element propagate
   * through the shadow boundary.
   */
  #adoptCss(): boolean {
    try {
      if (typeof CSSStyleSheet === "undefined" || !this.#root.adoptedStyleSheets) {
        return false;
      }
      const workbenchSheet = new CSSStyleSheet();
      workbenchSheet.replaceSync(REVIEW_WORKBENCH_CSS);
      // Inheritance delegation sheet — must come AFTER the workbench sheet.
      const inheritanceSheet = new CSSStyleSheet();
      inheritanceSheet.replaceSync(TOKEN_INHERIT_CSS);
      this.#root.adoptedStyleSheets = [workbenchSheet, inheritanceSheet];
      return true;
    } catch {
      return false;
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Register the element unless it's already defined (supports HMR scenarios).
if (typeof customElements !== "undefined" && !customElements.get("survey-review-workbench")) {
  customElements.define("survey-review-workbench", SurveyReviewWorkbenchElement);
}
