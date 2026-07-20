// Builds the Kontour Flow GitHub Pages site from README.md and docs/ into site/.
// Run with Node >= 22.18 (native TypeScript type stripping): node scripts/docs-site/build.ts
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const docsDir = path.join(repoRoot, "docs");
const outDir = path.join(repoRoot, "site");
const repoUrl = "https://github.com/kontourai/survey";
const siteUrl = "https://kontourai.github.io/survey";
const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as { version: string };

interface PageDef {
  src: string;
  out: string;
  navTitle: string;
  section: string;
}

interface NavSection {
  title: string;
  pages: PageDef[];
}

const pages: PageDef[] = [
  { src: "record-contracts.md", out: "record-contracts.html", navTitle: "Record Contracts", section: "Reference" },
  { src: "extraction-envelope-import.md", out: "extraction-envelope-import.html", navTitle: "Extraction Import", section: "Reference" },
  { src: "adversarial-and-learning.md", out: "adversarial-and-learning.html", navTitle: "Adversarial & Learning", section: "Reference" },
  { src: "consumer-integration-guide.md", out: "consumer-integration-guide.html", navTitle: "Consumer Guide", section: "Reference" },
  { src: "upgrade-guide.md", out: "upgrade-guide.html", navTitle: "Upgrade Guide", section: "Reference" },
  { src: "review-resource-contract.md", out: "review-resource-contract.html", navTitle: "Review Resources", section: "Reference" },
  { src: "source-authority-review-pattern.md", out: "source-authority-review-pattern.html", navTitle: "Source Authority", section: "Reference" },
  { src: "review-workbench-prototype.md", out: "review-workbench-prototype.html", navTitle: "Workbench Demo", section: "Project" },
  { src: "RELEASING.md", out: "releasing.html", navTitle: "Releasing", section: "Project" },
  { src: "adr/0001-reviewed-current-proposed-resolution.md", out: "adr/0001-reviewed-current-proposed-resolution.html", navTitle: "ADR 0001: Current/Proposed", section: "Decisions" },
  { src: "adr/0003-inquiry-mapping-and-producer-proposals.md", out: "adr/0003-inquiry-mapping-and-producer-proposals.html", navTitle: "ADR 0003: Inquiry Mapping", section: "Decisions" }
];

const navSections: NavSection[] = ["Reference", "Project", "Decisions"].map((title) => ({
  title,
  pages: pages.filter((page) => page.section === title)
}));

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z]+;|&#\d+;/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

// Pull fenced mermaid blocks out before markdown parsing so they render
// client-side instead of as code listings.
function extractMermaid(markdown: string): { markdown: string; hasMermaid: boolean } {
  let hasMermaid = false;
  const replaced = markdown.replace(/```mermaid\n([\s\S]*?)```/g, (_, body: string) => {
    hasMermaid = true;
    return `<pre class="mermaid">\n${escapeHtml(body)}</pre>`;
  });
  return { markdown: replaced, hasMermaid };
}

// Rewrite repo-relative markdown links into site or GitHub URLs.
function rewriteHref(href: string, pageDepth: number): string {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const toRoot = "../".repeat(pageDepth);
  const [target, fragment = ""] = href.split("#");
  const hash = fragment ? `#${fragment}` : "";
  const normalized = path.posix.normalize(target);

  if (normalized === "../README.md" || normalized === "README.md") return `${toRoot}index.html${hash}`;
  if (normalized.startsWith("../")) {
    // Outside docs/: examples, schemas, LICENSE, CHANGELOG live on GitHub.
    return `${repoUrl}/blob/main/${normalized.slice(3)}${hash}`;
  }
  if (normalized.endsWith(".md")) return `${toRoot}${normalized.replace(/\.md$/, ".html")}${hash}`;
  if (normalized.startsWith("assets/")) return `${toRoot}${normalized}`;
  return href;
}

function rewriteLinks(html: string, pageDepth: number): string {
  return html.replace(/(href|src)="([^"]+)"/g, (_, attr: string, href: string) => {
    return `${attr}="${rewriteHref(href, pageDepth)}"`;
  });
}

function addHeadingAnchors(html: string): string {
  const seen = new Map<string, number>();
  return html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_, level: string, body: string) => {
    let slug = slugify(body);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    if (count > 0) slug = `${slug}-${count}`;
    return `<h${level} id="${slug}">${body}<a class="anchor" href="#${slug}" aria-label="Link to this section">#</a></h${level}>`;
  });
}

function wrapTables(html: string): string {
  return html.replaceAll("<table>", '<div class="table-scroll"><table>').replaceAll("</table>", "</table></div>");
}

function navHtml(activeOut: string, pageDepth: number): string {
  const toRoot = "../".repeat(pageDepth);
  const sections = navSections
    .map((section) => {
      const links = section.pages
        .map((page) => {
          const active = page.out === activeOut ? ' aria-current="page"' : "";
          return `<li><a href="${toRoot}${page.out}"${active}>${page.navTitle}</a></li>`;
        })
        .join("\n");
      return `<section class="nav-group">\n<h2>${section.title}</h2>\n<ul>\n${links}\n</ul>\n</section>`;
    })
    .join("\n");
  return sections;
}

function layout(options: {
  title: string;
  description: string;
  bodyClass: string;
  content: string;
  activeOut: string;
  pageDepth: number;
  hasMermaid: boolean;
}): string {
  const { title, description, bodyClass, content, activeOut, pageDepth, hasMermaid } = options;
  const toRoot = "../".repeat(pageDepth);
  const mermaidScript = hasMermaid
    ? `<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: true, theme: dark ? "dark" : "neutral" });
</script>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#0a0e13" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f5f4ef" media="(prefers-color-scheme: light)">
<title>${escapeHtml(title)}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Kontour Survey">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${siteUrl}/assets/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${siteUrl}/assets/og-image.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${toRoot}styles.css">
<link rel="icon" href="${toRoot}favicon.svg" type="image/svg+xml">
</head>
<body class="${bodyClass}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <button class="nav-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="Toggle navigation">
    <span></span><span></span><span></span>
  </button>
  <a class="brand" href="${toRoot}index.html">
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">Kontour <strong>Survey</strong></span>
    <span class="version-badge">v${pkg.version}</span>
  </a>
  <nav class="header-links" aria-label="Primary">
    <a href="${toRoot}record-contracts.html">Docs</a>
    <a href="${toRoot}demo/">Live Demo</a>
    <a href="${repoUrl}" rel="noopener">GitHub</a>
    <a href="https://www.npmjs.com/package/@kontourai/survey" rel="noopener">npm</a>
  </nav>
</header>
<div class="shell">
  <nav id="site-nav" class="site-nav" aria-label="Documentation">
${navHtml(activeOut, pageDepth)}
  </nav>
  <div class="nav-backdrop" hidden></div>
  <main id="main" class="content">
${content}
  <footer class="site-footer">
    <p><strong>Kontour AI</strong> shows the work behind AI. Survey is the producer side of trust, feeding <a href="https://kontourai.io/surface" rel="noopener">Surface</a>.</p>
    <p><a href="${repoUrl}" rel="noopener">GitHub</a> · <a href="https://www.npmjs.com/package/@kontourai/survey" rel="noopener">npm</a> · <a href="${repoUrl}/blob/main/LICENSE" rel="noopener">Apache-2.0</a></p>
  </footer>
  </main>
</div>
<script>
const toggle = document.querySelector(".nav-toggle");
const nav = document.getElementById("site-nav");
const backdrop = document.querySelector(".nav-backdrop");
function setNav(open) {
  toggle.setAttribute("aria-expanded", String(open));
  nav.classList.toggle("open", open);
  backdrop.hidden = !open;
  document.body.classList.toggle("nav-open", open);
}
toggle.addEventListener("click", () => setNav(toggle.getAttribute("aria-expanded") !== "true"));
backdrop.addEventListener("click", () => setNav(false));
window.matchMedia("(min-width: 960px)").addEventListener("change", () => setNav(false));
</script>
${mermaidScript}
</body>
</html>
`;
}

async function renderDocPage(page: PageDef): Promise<void> {
  const raw = await readFile(path.join(docsDir, page.src), "utf8");
  const { markdown, hasMermaid } = extractMermaid(raw);
  const pageDepth = page.out.split("/").length - 1;
  let html = await marked.parse(markdown, { gfm: true });
  html = rewriteLinks(html, pageDepth);
  html = addHeadingAnchors(html);
  html = wrapTables(html);
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1] : page.navTitle;
  const description = `Kontour Survey documentation: ${title}.`;
  const output = layout({
    title: `${title} · Kontour Survey`,
    description,
    bodyClass: "doc-page",
    content: `<article class="doc">\n${html}\n</article>`,
    activeOut: page.out,
    pageDepth,
    hasMermaid
  });
  const target = path.join(outDir, page.out);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, output);
}

function landingContent(): string {
  return `
<section class="hero">
  <p class="hero-kicker">Kontour Survey · producer-side trust</p>
  <h1>Evidence, end to end.</h1>
  <p class="hero-lede">Every "verified" value has a story: where it was observed, what was extracted, what the alternatives were, who reviewed it, and what they decided. Survey is the contract that keeps that story — from raw source to reviewed claim — and projects it into Surface trust reports.</p>
  <div class="hero-actions">
    <a class="button primary" href="record-contracts.html">Explore the contracts</a>
    <a class="button" href="consumer-integration-guide.html">Consumer guide</a>
  </div>
</section>

<section class="features">
  <h2>Why producers adopt Survey</h2>
  <div class="feature-grid">
    <div class="feature">
      <h3>The chain stays inspectable</h3>
      <p>Typed records for sources, extractions, candidates, reviews, proofs, and resolutions — every link from raw material to claim can be re-examined after the fact.</p>
    </div>
    <div class="feature">
      <h3>One projection to Surface</h3>
      <p><code>buildSurveyTrustBundle</code> turns Survey records into a <a href="https://kontourai.io/surface" rel="noopener">Surface</a> Trust Bundle. Surface owns claims, evidence, status, and trust reporting from there.</p>
    </div>
    <div class="feature">
      <h3>A review workbench you can embed</h3>
      <p>Framework-neutral UI for ReviewItem queues: current vs proposed values, source evidence, decision controls, and a live Surface preview.</p>
    </div>
    <div class="feature">
      <h3>Server-owned apply boundary</h3>
      <p>Decisions derive from pre-decision snapshots plus persisted events — never browser-computed payloads — with freshness and replay checks built in.</p>
    </div>
    <div class="feature">
      <h3>Adversarial rounds on the record</h3>
      <p>Per-round adversarial-pass records serve as evidence for <a href="https://kontourai.github.io/flow/gates-and-route-back.html" rel="noopener">Flow's route-back gates</a>, so high-stakes review is a measured process, not a vibe.</p>
    </div>
    <div class="feature">
      <h3>Boundaries by design</h3>
      <p>Survey never crawls, parses, ranks, or decides truth. Producers own acquisition and policy; Survey owns the portable record contracts between them and Surface.</p>
    </div>
  </div>
</section>

<section class="showcase">
  <h2>The Review Workbench</h2>
  <p>A example-backed queue rendered by the embeddable workbench: current vs proposed values, source refs and excerpts, decision effect, and a preview of the saved record.</p>
  <p><a class="button primary" href="demo/">Open the live demo</a></p>
  <img src="assets/review-workbench-desktop.png" alt="Survey Review Workbench showing a review queue, current versus proposed values, decision controls, and a Surface preview" loading="lazy">
</section>

<section class="quickstart">
  <h2>One observation, one chain</h2>
  <pre><code>npm install @kontourai/survey @kontourai/surface</code></pre>
  <pre><code>const surveyInput = new SurveyInputBuilder({ source: "example-producer:run-1" })
  .addObservation({
    rawSource:     { kind: "web-page", sourceRef: "https://example.test/listings/123", ... },
    extraction:    { target: "availabilityStatus", value: "AVAILABLE", confidence: 0.92, ... },
    reviewOutcome: { status: "verified", actor: "example-operator", ... },
    claim:         { subjectId: "listing-123", claimType: "public-data.field", ... },
  })
  .build();

const trustBundle = validateTrustBundle(buildSurveyTrustBundle(surveyInput));
const report = buildTrustReport(trustBundle);</code></pre>
  <p><a class="button primary" href="record-contracts.html">Read the record contracts</a></p>
</section>
`;
}

async function build(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(path.join(docsDir, "assets"), path.join(outDir, "assets"), { recursive: true });
  await cp(path.join(repoRoot, "scripts", "docs-site", "styles.css"), path.join(outDir, "styles.css"));
  await cp(path.join(repoRoot, "scripts", "docs-site", "favicon.svg"), path.join(outDir, "favicon.svg"));
  await writeFile(path.join(outDir, ".nojekyll"), "");

  for (const page of pages) await renderDocPage(page);

  // Host the example-backed Review Workbench as a live demo at /demo/.
  const demoDir = path.join(outDir, "demo");
  await mkdir(demoDir, { recursive: true });
  await cp(path.join(repoRoot, "examples", "review-workbench", "vendor"), path.join(demoDir, "vendor"), { recursive: true });
  await cp(path.join(repoRoot, "examples", "review-workbench", "review-workbench.css"), path.join(demoDir, "review-workbench.css"));
  for (const compiled of ["src", "examples", "example-data"]) {
    await cp(path.join(repoRoot, "dist", compiled), path.join(demoDir, "dist", compiled), { recursive: true });
  }
  const demoHtml = await readFile(path.join(repoRoot, "examples", "review-workbench", "index.html"), "utf8");
  await writeFile(path.join(demoDir, "index.html"), demoHtml.replace("../../dist/", "./dist/"));

  const landing = layout({
    title: "Kontour Survey — producer-side evidence and review contracts",
    description: "Survey carries evidence from raw source to reviewed claim and projects it into Surface trust reports. Typed contracts plus an embeddable review workbench.",
    bodyClass: "landing",
    content: landingContent(),
    activeOut: "index.html",
    pageDepth: 0,
    hasMermaid: false
  });
  await writeFile(path.join(outDir, "index.html"), landing);
  console.log(`built ${pages.length + 1} pages into ${path.relative(repoRoot, outDir)}/`);
}

await build();
