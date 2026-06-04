const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = process.cwd();
const requiredFiles = [
  "examples/review-workbench/index.html",
  "examples/review-workbench/review-workbench.css",
  "examples/review-workbench/review-workbench-data.ts",
  "examples/review-workbench/review-workbench.ts",
  "dist/examples/review-workbench/review-workbench-data.js",
  "dist/examples/review-workbench/review-workbench.js",
  "dist/examples/review-workbench/review-workbench.d.ts",
];

for (const file of requiredFiles) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Missing review workbench artifact: ${file}`);
  }
}

const html = fs.readFileSync(path.join(root, "examples/review-workbench/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "examples/review-workbench/review-workbench.css"), "utf8");
const dataJs = fs.readFileSync(path.join(root, "dist/examples/review-workbench/review-workbench-data.js"), "utf8");
const js = fs.readFileSync(path.join(root, "dist/examples/review-workbench/review-workbench.js"), "utf8");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  assertIncludes(html, "id=\"review-workbench\"");
  assertIncludes(html, "../../dist/examples/review-workbench/review-workbench.js");
  assertIncludes(css, "@media (max-width: 980px)");
  assertIncludes(css, ".workbench-shell");
  assertIncludes(dataJs, "publicDirectoryReviewItemFixture");
  assertIncludes(js, "buildReviewDecision");
  assertIncludes(js, "mountReviewWorkbench");
  assertExcludes(js, "node:");
  assertExcludes(dataJs, "node:");
  await assertBrowserDataMatchesCanonicalFixture();

  console.log("Review workbench static artifact and fixture provenance check passed.");
}

async function assertBrowserDataMatchesCanonicalFixture() {
  const canonicalModule = await import(pathToFileURL(path.join(root, "dist/fixtures/public-directory-review-resource.js")).href);
  const browserModule = await import(pathToFileURL(path.join(root, "dist/examples/review-workbench/review-workbench-data.js")).href);

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
