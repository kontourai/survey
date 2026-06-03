#!/usr/bin/env node

const { accessSync, constants, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const repoRoot = process.cwd();
const findings = [];

function fail(message) {
  findings.push(message);
}

function readText(relativePath) {
  try {
    return readFileSync(join(repoRoot, relativePath), "utf8");
  } catch (error) {
    fail(`${relativePath} is missing or unreadable: ${error.message}`);
    return "";
  }
}

function requireText(relativePath, content, expected, label = expected) {
  if (!content.includes(expected)) {
    fail(`${relativePath} must include ${label}`);
  }
}

function meaningfulShellLines(content) {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

const packageJson = JSON.parse(readText("package.json") || "{}");
const scripts = packageJson.scripts || {};

if (scripts["setup:repo-hooks"] !== "node scripts/setup-repo-hooks.cjs") {
  fail("package.json scripts.setup:repo-hooks must run node scripts/setup-repo-hooks.cjs");
}

if (scripts["validate:repo-hooks"] !== "node scripts/validate-repo-hooks.cjs") {
  fail("package.json scripts.validate:repo-hooks must run node scripts/validate-repo-hooks.cjs");
}

const hook = readText(".githooks/pre-push");
try {
  accessSync(join(repoRoot, ".githooks", "pre-push"), constants.X_OK);
} catch {
  fail(".githooks/pre-push must exist and be executable");
}

requireText(".githooks/pre-push", hook, "#!/usr/bin/env sh", "a POSIX sh shebang");
const hookLines = meaningfulShellLines(hook);
const expectedHookLines = [
  "set -eu",
  'repo_root="$(git rev-parse --show-toplevel)"',
  'cd "$repo_root"',
  'echo "Survey pre-push validation: repo hook drift"',
  "npm run validate:repo-hooks",
  'echo "Survey pre-push validation: package verification"',
  "npm run verify",
];
if (hookLines.join("\n") !== expectedHookLines.join("\n")) {
  fail(`.githooks/pre-push command sequence drifted. Expected:\n${expectedHookLines.join("\n")}\nActual:\n${hookLines.join("\n")}`);
}

const setup = readText("scripts/setup-repo-hooks.cjs");
requireText("scripts/setup-repo-hooks.cjs", setup, '"--local"', "local git config");
requireText("scripts/setup-repo-hooks.cjs", setup, '"core.hooksPath"');
requireText("scripts/setup-repo-hooks.cjs", setup, '".githooks"');
if (setup.includes('"--global"') || setup.includes("'--global'")) {
  fail("scripts/setup-repo-hooks.cjs must not use global git config");
}

const readme = readText("README.md");
requireText("README.md", readme, "npm run setup:repo-hooks");
requireText("README.md", readme, "npm run validate:repo-hooks");
requireText("README.md", readme, "npm run verify");
requireText("README.md", readme, "buildSurveyTrustInput");
requireText("README.md", readme, "validateTrustInput");
requireText("README.md", readme, "buildTrustReport");
requireText("README.md", readme, "producer operational state outside Survey");

const docsToScan = [
  "README.md",
  "docs/source-authority-review-pattern.md",
  "scripts/setup-repo-hooks.cjs",
  "scripts/validate-repo-hooks.cjs",
  ".githooks/pre-push",
];

function words(parts) {
  return parts.join(" ");
}

function literalPattern(parts) {
  return new RegExp(parts.join("").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function phrasePattern(parts) {
  return new RegExp(words(parts).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function wordPattern(parts) {
  return new RegExp("\\b" + parts.join("").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
}

const forbidden = [
  { label: "private dot-directory", pattern: literalPattern([".", "k", "o", "n", "t", "o", "u", "r"]) },
  { label: "private console product", pattern: phrasePattern(["Kontour", "Console"]) },
  { label: "private product workflow", pattern: phrasePattern(["console", "workflow"]) },
  { label: "private admin interface", pattern: phrasePattern(["admin", "UI"]) },
  { label: "private downstream coupling", pattern: phrasePattern(["downstream", "app"]) },
  { label: "private product example", pattern: literalPattern(["C", "a", "m", "p", "F", "i", "t"]) },
  { label: "private regulated product example", pattern: wordPattern(["T", "a", "x", "e", "s"]) },
  { label: "private regulated product term", pattern: wordPattern(["t", "a", "x"]) },
];

for (const relativePath of docsToScan) {
  const content = readText(relativePath);
  for (const term of forbidden) {
    const match = term.pattern.exec(content);
    if (match) {
      const line = content.slice(0, match.index).split("\n").length;
      fail(`${relativePath}:${line} contains ${term.label}`);
    }
  }
}

try {
  const mode = statSync(join(repoRoot, ".githooks", "pre-push")).mode;
  if ((mode & 0o111) === 0) {
    fail(".githooks/pre-push must have at least one executable bit set");
  }
} catch {
  fail(".githooks/pre-push must be stat-able");
}

if (findings.length > 0) {
  console.error("Repo hook validation failed:");
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log("Repo hook validation passed.");
