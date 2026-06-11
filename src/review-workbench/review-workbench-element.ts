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

    // Host token defaults: CSS custom properties inherit through the shadow
    // boundary so host overrides win automatically. These are the defaults
    // that apply when no ancestor sets the tokens.
    const hostStyle = document.createElement("style");
    hostStyle.textContent = `
      :host {
        display: block;
        container-type: inline-size;
        /* --k-bg, --k-panel, etc. are set by the Console Kit theme stylesheet.
           Declare fallback token values here so shadow content has something
           to work with even if the host doesn't load Console Kit. */
        --k-bg: var(--k-bg, #060a10);
        --k-panel: var(--k-panel, #101822);
        --k-panel-raised: var(--k-panel-raised, #161e2b);
        --k-text: var(--k-text, #e8eaf0);
        --k-text-muted: var(--k-text-muted, #8b93a8);
        --k-text-faint: var(--k-text-faint, #4e5870);
        --k-line: var(--k-line, rgba(255,255,255,0.08));
        --k-line-strong: var(--k-line-strong, rgba(255,255,255,0.14));
        --k-brand: var(--k-brand, #5ce0c6);
        --k-active: var(--k-active, #7aa2ff);
        --k-positive: var(--k-positive, #34d399);
        --k-caution: var(--k-caution, #f3b14b);
        --k-negative: var(--k-negative, #ff6f6f);
        --k-radius-md: var(--k-radius-md, 10px);
        --k-radius-sm: var(--k-radius-sm, 6px);
        --k-font-ui: var(--k-font-ui, "Hanken Grotesk", system-ui, sans-serif);
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
    if (colorScheme === "light") {
      this.#mountRoot.removeAttribute("data-dark");
    } else {
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

  /** Attempt to inject the workbench CSS via constructable CSSStyleSheet. */
  #adoptCss(): boolean {
    try {
      if (typeof CSSStyleSheet === "undefined" || !this.#root.adoptedStyleSheets) {
        return false;
      }
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(REVIEW_WORKBENCH_CSS);
      this.#root.adoptedStyleSheets = [sheet];
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
