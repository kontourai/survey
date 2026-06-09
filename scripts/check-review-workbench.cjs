const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = process.cwd();
const requiredFiles = [
  "examples/review-workbench/index.html",
  "examples/review-workbench/review-workbench.css",
  "examples/review-workbench/vendor/console-kit/tokens/index.css",
  "examples/review-workbench/vendor/console-kit/tokens/tokens.css",
  "examples/review-workbench/vendor/console-kit/tokens/themes.css",
  "examples/review-workbench/vendor/console-kit/tokens/fonts.css",
  "examples/review-workbench/review-workbench.ts",
  "src/review-workbench/review-workbench-data.ts",
  "src/review-workbench/review-presentation.ts",
  "src/review-workbench/review-queue-session.ts",
  "src/review-workbench/review-surface-preview.ts",
  "src/review-workbench/review-workbench.ts",
  "scripts/copy-review-workbench-package-assets.cjs",
  "scripts/sync-review-workbench-assets.cjs",
  "dist/examples/review-workbench/review-workbench.js",
  "dist/src/review-workbench/review-workbench-data.js",
  "dist/src/review-workbench/review-presentation.js",
  "dist/src/review-workbench/review-queue-session.js",
  "dist/src/review-workbench/review-surface-preview.js",
  "dist/src/review-workbench/review-workbench.js",
  "dist/src/review-workbench/review-workbench.d.ts",
  "dist/src/review-workbench/review-presentation.d.ts",
  "dist/src/review-workbench/review-queue-session.d.ts",
  "dist/src/review-workbench/review-surface-preview.d.ts",
  "dist/src/review-workbench/review-workbench.css",
  "dist/src/review-workbench/review-workbench.standalone.css",
];

for (const file of requiredFiles) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Missing review workbench artifact: ${file}`);
  }
}

const html = fs.readFileSync(path.join(root, "examples/review-workbench/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "examples/review-workbench/review-workbench.css"), "utf8");
const dataJs = fs.readFileSync(path.join(root, "dist/src/review-workbench/review-workbench-data.js"), "utf8");
const presentationJs = fs.readFileSync(path.join(root, "dist/src/review-workbench/review-presentation.js"), "utf8");
const queueSessionJs = fs.readFileSync(path.join(root, "dist/src/review-workbench/review-queue-session.js"), "utf8");
const surfacePreviewJs = fs.readFileSync(path.join(root, "dist/src/review-workbench/review-surface-preview.js"), "utf8");
const js = fs.readFileSync(path.join(root, "dist/src/review-workbench/review-workbench.js"), "utf8");
const embedCss = fs.readFileSync(path.join(root, "dist/src/review-workbench/review-workbench.css"), "utf8");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  assertIncludes(html, "id=\"review-workbench\"");
  assertIncludes(html, "class=\"theme-survey\"");
  assertIncludes(html, "./vendor/console-kit/tokens/index.css");
  assertIncludes(html, "./review-workbench.css");
  assertIncludes(html, "rel=\"icon\"");
  assertIncludes(html, "data:image/svg+xml");
  assertIncludes(html, "../../dist/examples/review-workbench/review-workbench.js");
  assertIncludes(css, "@media (max-width: 980px)");
  assertIncludes(css, ".workbench-shell");
  assertIncludes(css, "grid-template-columns: minmax(0, 1fr)");
  assertIncludes(css, ".meta-grid {\n  display: none;");
  assertIncludes(css, ".payload-panel summary.field-label");
  assertIncludes(css, ".reference-details summary");
  assertIncludes(css, "overflow-wrap: anywhere");
  assertIncludes(css, "--ink-1000: var(--k-bg)");
  assertIncludes(css, "--accent: var(--k-brand)");
  assertIncludes(embedCss, "Bundled, scoped Survey Review Workbench styles");
  assertIncludes(embedCss, ".survey-workbench-embed");
  assertIncludes(embedCss, ".survey-workbench-embed .workbench-shell");
  assertIncludes(embedCss, ".survey-workbench-embed::before");
  assertIncludes(embedCss, "position: absolute;");
  assertEquals((embedCss.match(/^@import /gm) ?? []).length, 0);
  assertExcludes(embedCss, "position: fixed;");
  assertExcludes(embedCss, "\nbody {");
  assertExcludes(embedCss, "\n:root {");
  assertIncludes(dataJs, "publicDirectoryReviewItemFixture");
  assertIncludes(dataJs, "facilityCredentialReviewItemFixture");
  assertIncludes(dataJs, "facility-credential-review-operating-license");
  assertIncludes(dataJs, "reviewWorkbenchQueueFixtures");
  assertIncludes(presentationJs, "buildReviewItemPresentation");
  assertIncludes(presentationJs, "buildReviewResultPresentation");
  assertIncludes(presentationJs, "humanizeIdentifier");
  assertIncludes(queueSessionJs, "initialReviewQueueSessionState");
  assertIncludes(queueSessionJs, "deriveQueueRowStatus");
  assertIncludes(queueSessionJs, "reviewSessionSummary");
  assertIncludes(queueSessionJs, "nextUnresolvedItemName");
  assertIncludes(queueSessionJs, "selectedCandidateRole");
  assertIncludes(queueSessionJs, "candidateRole: \"proposed\"");
  assertIncludes(js, "buildReviewDecision");
  assertIncludes(surfacePreviewJs, "buildSurfaceProjectionPreview");
  assertIncludes(js, "renderCurrentState");
  assertIncludes(js, "updateReviewerNote");
  assertIncludes(js, "selectDecision");
  assertIncludes(js, "selectQueueItem");
  assertIncludes(js, "goToNextUnresolved");
  assertIncludes(js, "Review queue");
  assertIncludes(js, "Session summary");
  assertIncludes(js, "Producer feedback tags");
  assertIncludes(js, "Surface preview");
  assertIncludes(js, "IDs and trace links");
  assertIncludes(js, "incoming value");
  assertIncludes(js, "authorityTrace");
  assertIncludes(dataJs, "sourceAuthority");
  assertIncludes(dataJs, "feedbackTags");
  assertIncludes(js, "mountReviewWorkbench");
  assertExcludes(js, "node:");
  assertExcludes(js, "@kontourai/surface");
  assertExcludes(js, "src/to-surface");
  assertExcludes(js, "src/review-proof");
  assertExcludes(dataJs, "node:");
  assertExcludes(dataJs, "@kontourai/surface");
  assertExcludes(dataJs, "src/to-surface");
  assertExcludes(dataJs, "src/review-proof");
  assertExcludes(presentationJs, "node:");
  assertExcludes(presentationJs, "@kontourai/surface");
  assertExcludes(presentationJs, "src/to-surface");
  assertExcludes(presentationJs, "src/review-proof");
  assertExcludes(queueSessionJs, "node:");
  assertExcludes(queueSessionJs, "@kontourai/surface");
  assertExcludes(queueSessionJs, "src/to-surface");
  assertExcludes(queueSessionJs, "src/review-proof");
  assertExcludes(surfacePreviewJs, "node:");
  assertExcludes(surfacePreviewJs, "@kontourai/surface");
  assertExcludes(surfacePreviewJs, "src/to-surface");
  assertExcludes(surfacePreviewJs, "src/review-proof");
  await assertBrowserDataMatchesCanonicalFixture();

  console.log("Review workbench static artifact and fixture provenance check passed.");
}

async function assertBrowserDataMatchesCanonicalFixture() {
  const canonicalModule = await import(pathToFileURL(path.join(root, "dist/fixtures/public-directory-review-resource.js")).href);
  const browserModule = await import(pathToFileURL(path.join(root, "dist/src/review-workbench/review-workbench-data.js")).href);

  const canonicalFixture = canonicalModule.publicDirectoryReviewItemFixture;
  const browserFixture = browserModule.publicDirectoryReviewItemFixture;

  if (JSON.stringify(browserFixture) !== JSON.stringify(canonicalFixture)) {
    throw new Error(
      "Review workbench browser-safe fixture drifted from fixtures/public-directory-review-resource.ts. " +
        "Update examples/review-workbench/review-workbench-data.ts to match the canonical ReviewItem fixture.",
    );
  }
}

function assertIncludes(content, expected) {
  if (!content.includes(expected)) {
    throw new Error(`Expected review workbench artifact to include: ${expected}`);
  }
}

function assertExcludes(content, unexpected) {
  if (content.includes(unexpected)) {
    throw new Error(`Expected review workbench artifact not to include: ${unexpected}`);
  }
}

function assertEquals(actual, expected) {
  if (actual !== expected) {
    throw new Error(`Expected review workbench artifact value ${expected}, received ${actual}`);
  }
}
