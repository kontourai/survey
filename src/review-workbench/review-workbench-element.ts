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
 *   theme       — "survey" | "console" | "flow" | "surface"  (maps to theme-* class)
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
import { REVIEW_WORKBENCH_CSS } from "./review-workbench-css.generated.js";

/** @internal Second adopted stylesheet: host token defaults + inheritance delegation.
 *
 * This sheet is adopted AFTER the main workbench CSS (adoptedStyleSheets[1]).
 * It serves two purposes:
 *
 * 1.  :host literal defaults — non-self-referential literal values for all --k-* tokens.
 *     These provide a baseline when the host page does not load Console Kit.
 *     Because they are literal (not var()), there is no self-reference cycle.
 *     Inline styles on the host element always win over :host rules, so setting
 *     `--k-brand: hotpink` on the element naturally overrides the #5ce0c6 default.
 *
 * 2.  .survey-workbench-embed[class] inherit delegation — using specificity (0,2,0)
 *     to match the theme class selectors (e.g. .survey-workbench-embed.theme-survey).
 *     Source order (after the workbench sheet) makes these inherit rules win, so the
 *     embed's tokens propagate upward to :host, picking up any host overrides.
 */
const TOKEN_INHERIT_CSS = `/* 1. Host token defaults — literal values, not var() self-references.
   Inline styles on the host element always win over :host rules so external
   overrides (e.g. style="--k-brand: hotpink") propagate through automatically. */
:host {
  display: block;
  container-type: inline-size;
  --k-bg: #060a10;
  --k-panel: #101822;
  --k-panel-raised: #161e2b;
  --k-text: #e8eaf0;
  --k-text-muted: #8b93a8;
  --k-text-faint: #4e5870;
  --k-line: rgba(255,255,255,0.08);
  --k-line-strong: rgba(255,255,255,0.14);
  --k-brand: #5ce0c6;
  --k-active: #7aa2ff;
  --k-positive: #34d399;
  --k-caution: #f3b14b;
  --k-negative: #ff6f6f;
  --k-neutral: #8b93a8;
  --k-radius-md: 10px;
  --k-radius-sm: 6px;
  --k-font-ui: "Hanken Grotesk", system-ui, sans-serif;
}
/* 2. Token inheritance delegation — re-delegate --k-* tokens on the embed root
   to inherit from :host, so external overrides set on the host element propagate
   through the shadow boundary. The [class] attribute selector raises specificity
   to (0,2,0) — matching the theme class selectors — and this sheet comes AFTER
   the workbench defaults, so source order makes these rules win. */
.survey-workbench-embed[class] {
  --k-bg: inherit;
  --k-panel: inherit;
  --k-panel-raised: inherit;
  --k-text: inherit;
  --k-text-muted: inherit;
  --k-text-faint: inherit;
  --k-line: inherit;
  --k-line-strong: inherit;
  --k-brand: inherit;
  --k-active: inherit;
  --k-positive: inherit;
  --k-caution: inherit;
  --k-negative: inherit;
  --k-neutral: inherit;
  --k-radius-md: inherit;
  --k-radius-sm: inherit;
  --k-font-ui: inherit;
  --k-font-mono: inherit;
  --k-font-display: inherit;
}
/* 3. Light mode token overrides — applied when color-scheme="light" sets data-theme="light"
   on the embed root. These are literal values (not var()) to avoid self-reference cycles.
   The [data-theme="light"] selector has specificity (0,1,0) which is overridden by the
   .survey-workbench-embed[class] inheritance block above for the embed container,
   but the override chain means host-level --k-* tokens still win. */
.survey-workbench-embed[data-theme="light"] {
  color-scheme: light;
  --k-bg: #f5f4ef;
  --k-panel: #ffffff;
  --k-panel-raised: #fbfaf7;
  --k-line: rgba(36, 40, 46, 0.12);
  --k-line-strong: rgba(36, 40, 46, 0.20);
  --k-text: #202124;
  --k-text-muted: #5b626b;
  --k-text-faint: #707782;
  --k-brand: #16806f;
  --k-positive: #168257;
  --k-caution: #8a5a00;
  --k-negative: #c83b3b;
  --k-active: #3f6fd6;
}`;

export class SurveyReviewWorkbenchElement extends HTMLElement {
  static readonly observedAttributes = ["theme", "color-scheme", "src"];

  #session: ReviewQueueSessionState | ReviewWorkbenchState | null = null;
  #presentationAdapter: ReviewPresentationAdapter | undefined = undefined;
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
      const styleEl = document.createElement("style");
      styleEl.textContent = REVIEW_WORKBENCH_CSS;
      this.#root.appendChild(styleEl);
    }

    // Fallback <style> element for browsers that do not support adoptedStyleSheets.
    // When adoptedStyleSheets are available, TOKEN_INHERIT_CSS (the second adopted
    // sheet) handles :host defaults and embed token delegation — and wins over this
    // <style> element in the cascade.  This <style> is only active in the fallback
    // path, so using literal values here is safe: there is no self-reference cycle.
    const hostStyle = document.createElement("style");
    hostStyle.textContent = `
      :host {
        display: block;
        container-type: inline-size;
        /* Literal token defaults (no var() self-references) so the values resolve
           correctly even when the adopted inheritance sheet is unavailable. */
        --k-bg: #060a10;
        --k-panel: #101822;
        --k-panel-raised: #161e2b;
        --k-text: #e8eaf0;
        --k-text-muted: #8b93a8;
        --k-text-faint: #4e5870;
        --k-line: rgba(255,255,255,0.08);
        --k-line-strong: rgba(255,255,255,0.14);
        --k-brand: #5ce0c6;
        --k-active: #7aa2ff;
        --k-positive: #34d399;
        --k-caution: #f3b14b;
        --k-negative: #ff6f6f;
        --k-radius-md: 10px;
        --k-radius-sm: 6px;
        --k-font-ui: "Hanken Grotesk", system-ui, sans-serif;
      }
      .workbench-empty, .workbench-error {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 6rem;
        padding: 1.5rem;
        font-family: var(--k-font-ui, system-ui, sans-serif);
        font-size: 0.9rem;
        color: var(--k-text-muted, #8b93a8);
        background: var(--k-panel, #101822);
        border-radius: var(--k-radius-md, 10px);
      }
      .workbench-error {
        color: var(--k-negative, #ff6f6f);
      }
      /* Delegate k-tokens from :host to the embed container so host-element inline
         style overrides propagate through the shadow boundary. This rule has same
         specificity as the workbench CSS token defaults but comes after them in
         document order, so it wins and allows inheritance from :host. */
      .survey-workbench-embed {
        --k-bg: inherit;
        --k-panel: inherit;
        --k-panel-raised: inherit;
        --k-text: inherit;
        --k-text-muted: inherit;
        --k-text-faint: inherit;
        --k-line: inherit;
        --k-line-strong: inherit;
        --k-brand: inherit;
        --k-active: inherit;
        --k-positive: inherit;
        --k-caution: inherit;
        --k-negative: inherit;
        --k-radius-md: inherit;
        --k-radius-sm: inherit;
        --k-font-ui: inherit;
        --k-font-mono: inherit;
        --k-font-display: inherit;
      }
    `;
    this.#root.appendChild(hostStyle);

    this.#mountRoot = document.createElement("div");
    this.#mountRoot.className = "workbench survey-workbench-embed";
    this.#root.appendChild(this.#mountRoot);
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
    this.#mountRoot.className = `workbench survey-workbench-embed theme-${theme}`;
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

    const options: MountReviewWorkbenchOptions = this.#presentationAdapter
      ? { presentationAdapter: this.#presentationAdapter }
      : {};

    this.#applyThemeClasses();
    mountReviewWorkbench(this.#mountRoot, this.#session, options);
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
   * Two sheets are adopted: the main workbench CSS first, then a
   * token-inheritance sheet that resets all --k-* tokens to `inherit`
   * on .survey-workbench-embed.  Because later entries in adoptedStyleSheets
   * win over earlier ones at equal specificity, the inheritance rules
   * override the workbench token defaults.  This allows host-element inline
   * style overrides (or any ancestor's CSS custom properties) to propagate
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
