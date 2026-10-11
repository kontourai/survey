// Adds the example-backed Review Workbench live demo to a built docs site at
// $DOCS_SITE_DIR/demo/ (published as https://kontourai.github.io/survey/demo/).
// docs-kit renders only Markdown, so the org docs-pages workflow runs this as
// its add-only extra build. Run `npm run build` first; `npm run docs:demo` does both.
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  console.error(`build-demo: ${message}`);
  process.exit(1);
}

const siteDirEnv = process.env.DOCS_SITE_DIR;
if (!siteDirEnv) fail("DOCS_SITE_DIR is not set; point it at the docs-kit build output");
const siteDir = path.resolve(siteDirEnv);
if (!(await stat(siteDir).catch(() => null))?.isDirectory()) fail(`${siteDir} is not a directory; run docs-kit build first`);

const demoDir = path.join(siteDir, "demo");
// The extra build may only add files, so never write over existing output.
if (existsSync(demoDir)) fail(`${demoDir} already exists`);

const exampleDir = path.join(repoRoot, "examples", "review-workbench");
const distDir = path.join(repoRoot, "dist");
for (const compiled of ["src", "examples", "example-data"]) {
  if (!existsSync(path.join(distDir, compiled))) fail(`dist/${compiled} is missing; run npm run build first`);
}

await mkdir(demoDir, { recursive: true });
await cp(path.join(exampleDir, "vendor"), path.join(demoDir, "vendor"), { recursive: true });
await cp(path.join(exampleDir, "review-workbench.css"), path.join(demoDir, "review-workbench.css"));
for (const compiled of ["src", "examples", "example-data"]) {
  await cp(path.join(distDir, compiled), path.join(demoDir, "dist", compiled), { recursive: true });
}

// The example page loads the compiled module from the repo-root dist/; the demo
// ships its own copy beside index.html.
const demoHtml = await readFile(path.join(exampleDir, "index.html"), "utf8");
if (!demoHtml.includes("../../dist/")) fail("examples/review-workbench/index.html no longer references ../../dist/");
await writeFile(path.join(demoDir, "index.html"), demoHtml.replace("../../dist/", "./dist/"));

console.log(`build-demo: wrote ${demoDir}/`);
