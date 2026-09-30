const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "examples", "review-workbench");
const distRoot = path.join(root, "dist", "src", "review-workbench");
const generatedTsPath = path.join(root, "src", "review-workbench", "review-workbench-css.generated.ts");
// Token CSS is read from the INSTALLED @kontourai/ui, not from the vendored
// copy, so `--check` fails as soon as the committed module drifts from the
// package the lockfile resolves (kontourai/survey#323). The vendored copy under
// examples/ is held to the same package by sync-review-workbench-assets.cjs --check.
const installedKitRoot = path.join(root, "node_modules", "@kontourai", "ui");
const checkOnly = process.argv.includes("--check");

// Tokens the <survey-review-workbench> element declares as literal :host
// defaults (dark, from tokens.css :root) and re-declares for color-scheme="light"
// (from tokens.css [data-theme="light"]). Emitted from the package so the
// element carries no hand-copied color values. A name the package stops
// declaring fails generation rather than silently dropping out.
const ELEMENT_DARK_TOKENS = [
  "--k-bg", "--k-panel", "--k-panel-raised",
  "--k-text", "--k-text-muted", "--k-text-faint",
  "--k-line", "--k-line-strong",
  "--k-brand", "--k-brand-contrast",
  "--k-active", "--k-positive", "--k-caution", "--k-negative", "--k-neutral",
  "--k-positive-soft", "--k-caution-soft", "--k-negative-soft", "--k-active-soft",
  "--k-radius-md", "--k-radius-sm", "--k-shadow", "--k-font-ui",
];
const ELEMENT_LIGHT_TOKENS = [
  "--k-bg", "--k-panel", "--k-panel-raised",
  "--k-line", "--k-line-strong", "--k-shadow",
  "--k-text", "--k-text-muted", "--k-text-faint",
  "--k-brand", "--k-brand-contrast",
  "--k-positive", "--k-caution", "--k-negative", "--k-neutral", "--k-active",
  "--k-positive-soft", "--k-caution-soft", "--k-negative-soft", "--k-active-soft",
];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const tokenRoot = await resolveInstalledTokenRoot();
  const tokensCss = await fs.readFile(path.join(tokenRoot, "tokens.css"), "utf8");
  const themesCss = await fs.readFile(path.join(tokenRoot, "themes.css"), "utf8");
  const cssText = await buildEmbeddedWorkbenchCss(tokensCss, themesCss);
  const generatedModule = buildCssGeneratedModule(cssText, {
    dark: pickTokenDeclarations(tokensCss, ":root", ELEMENT_DARK_TOKENS),
    light: pickTokenDeclarations(tokensCss, '[data-theme="light"]', ELEMENT_LIGHT_TOKENS),
  });

  if (checkOnly) {
    const existing = await fs.readFile(generatedTsPath, "utf8").catch(() => null);
    if (existing !== generatedModule) {
      throw new Error(
        "review-workbench-css.generated.ts is out of date with the installed @kontourai/ui " +
          "or examples/review-workbench/review-workbench.css. " +
          "Run `node scripts/copy-review-workbench-package-assets.cjs` to regenerate it.",
      );
    }
    console.log("review-workbench-css.generated.ts is up to date.");
    return;
  }

  await fs.mkdir(distRoot, { recursive: true });
  await fs.copyFile(
    path.join(sourceRoot, "review-workbench.css"),
    path.join(distRoot, "review-workbench.standalone.css"),
  );
  await fs.writeFile(
    path.join(distRoot, "review-workbench.css"),
    cssText,
  );
  await fs.cp(
    path.join(sourceRoot, "vendor"),
    path.join(distRoot, "vendor"),
    { recursive: true },
  );

  // Emit the CSS-as-TS module into src/ so the web component can import it
  // directly and stay self-contained. This file is committed (like surface's
  // assets.generated.ts) so CI without build steps can still type-check.
  await fs.writeFile(generatedTsPath, generatedModule);
  console.log("Emitted review-workbench-css.generated.ts.");
}

async function resolveInstalledTokenRoot() {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(installedKitRoot, "package.json"), "utf8").catch(() => {
      throw new Error("Missing @kontourai/ui. Run pnpm install before generating review workbench CSS.");
    }),
  );
  if (packageJson.name !== "@kontourai/ui") {
    throw new Error(`Expected @kontourai/ui at ${installedKitRoot}, found ${packageJson.name ?? "unnamed package"}.`);
  }
  return path.join(installedKitRoot, "tokens");
}

/**
 * Read the named custom properties from the one rule whose selector list is
 * exactly `selector`, and return them as declaration lines in the order asked.
 * Throws when the rule is missing, ambiguous, or lacks a requested name.
 */
function pickTokenDeclarations(css, selector, names) {
  const uncommented = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...uncommented.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].trim() === selector);
  if (rules.length !== 1) {
    throw new Error(`Expected exactly one \`${selector}\` rule in @kontourai/ui tokens.css, found ${rules.length}.`);
  }
  const declarations = new Map();
  for (const [, name, value] of rules[0][2].matchAll(/(--k-[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(name, value.replace(/\s+/g, " ").trim());
  }
  return names.map((name) => {
    if (!declarations.has(name)) {
      throw new Error(`@kontourai/ui tokens.css \`${selector}\` no longer declares ${name}.`);
    }
    return `  ${name}: ${declarations.get(name)};`;
  }).join("\n");
}

async function buildEmbeddedWorkbenchCss(tokensCss, themesCss) {
  const workbenchCss = await fs.readFile(path.join(sourceRoot, "review-workbench.css"), "utf8");
  const scopedWorkbenchCss = containEmbeddedWorkbenchOverlay(
    scopeCssForEmbeddedWorkbench(stripCssImports(workbenchCss)),
  );

  return [
    "/* Bundled, scoped Survey Review Workbench styles for downstream embeds. Font loading is left to the host app. */",
    // Token defaults are emitted VERBATIM (literal values), only re-scoped from
    // :root to .survey-workbench-embed. They must never be rewritten to
    // `--k-x: var(--k-x, <default>)`: a custom property whose value references
    // itself is a cycle, which is invalid at computed-value time — the property
    // resolves to the guaranteed-invalid value, the fallback is never reached,
    // and EVERY token dies inside the embed (kontourai/survey#202). A
    // declaration on the embed root also always beats a value inherited from a
    // host ancestor, so no self-reference can express "use the host's value if
    // it set one"; hosts theme the light-DOM embed by declaring --k-* on the
    // embed element itself, or by using <survey-review-workbench>, whose shadow
    // :host defaults are genuinely inheritable. Keeping the emitted cascade
    // byte-identical to the standalone stylesheet also keeps the embed's
    // internal tie-breaks (theme presets vs. [data-theme="light"]) intact.
    scopeCssForEmbeddedWorkbench(tokensCss),
    scopeCssForEmbeddedWorkbench(themesCss),
    scopedWorkbenchCss,
    [
      ".survey-workbench-embed {",
      "  overflow: hidden;",
      "}",
    ].join("\n"),
  ].join("\n");
}

/**
 * Wrap CSS text in a TS module that exports it as a default string.
 * The element imports this at build time so no runtime fetch is required.
 */
function buildCssGeneratedModule(cssText, elementTokens) {
  return [
    "// Generated by scripts/copy-review-workbench-package-assets.cjs from CSS sources.",
    "// Do not edit directly; edit examples/review-workbench/review-workbench.css or bump @kontourai/ui instead.",
    "/* eslint-disable */",
    `export const REVIEW_WORKBENCH_CSS: string = \`${escapeTemplateLiteral(cssText)}\`;`,
    "/** Literal dark token defaults for the element's :host, from @kontourai/ui tokens.css :root. */",
    `export const REVIEW_WORKBENCH_DARK_TOKEN_DECLARATIONS: string = \`${escapeTemplateLiteral(elementTokens.dark)}\`;`,
    "/** Literal light token values for the element's color-scheme=\"light\", from @kontourai/ui tokens.css [data-theme=\"light\"]. */",
    `export const REVIEW_WORKBENCH_LIGHT_TOKEN_DECLARATIONS: string = \`${escapeTemplateLiteral(elementTokens.light)}\`;`,
    "export default REVIEW_WORKBENCH_CSS;",
    "",
  ].join("\n");
}

function escapeTemplateLiteral(text) {
  // Escape backslashes, backticks and template-literal sigils.
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function stripCssImports(css) {
  return css
    .split("\n")
    .filter((line) => !line.trim().startsWith("@import "))
    .join("\n");
}

function containEmbeddedWorkbenchOverlay(css) {
  // Replace all position: fixed with position: absolute in the embedded variant.
  // The .survey-workbench-embed container has overflow: hidden, so absolute
  // positioning achieves the same visual containment without escaping the host DOM.
  return css.replace(/position: fixed;/g, 'position: absolute;');
}
function scopeCssForEmbeddedWorkbench(css) {
  const scopedLines = [];
  const pendingSelectorLines = [];
  let blockDepth = 0;
  let declarationDepth = 0;
  let inComment = false;

  for (const line of css.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith("/*")) inComment = true;
    if (inComment) {
      scopedLines.push(line);
      if (trimmed.endsWith("*/")) inComment = false;
      continue;
    }

    if (declarationDepth > 0) {
      scopedLines.push(line);
      const delta = braceDelta(line);
      blockDepth += delta;
      declarationDepth += delta;
      continue;
    }

    if (pendingSelectorLines.length) {
      pendingSelectorLines.push(line);
      if (line.includes("{")) {
        const scopedBlock = scopeSelectorBlock(pendingSelectorLines.join("\n"));
        scopedLines.push(scopedBlock);
        const delta = braceDelta(scopedBlock);
        blockDepth += delta;
        declarationDepth += delta;
        pendingSelectorLines.length = 0;
      }
      continue;
    }

    if (trimmed === "") {
      scopedLines.push(line);
      continue;
    }

    if (trimmed.startsWith("@")) {
      scopedLines.push(line);
      blockDepth += braceDelta(line);
      continue;
    }

    if (trimmed === "}") {
      scopedLines.push(line);
      blockDepth += braceDelta(line);
      continue;
    }

    if (!line.includes("{")) {
      if (blockDepth === 0 || (blockDepth > 0 && trimmed.endsWith(","))) {
        pendingSelectorLines.push(line);
      } else {
        scopedLines.push(line);
      }
      continue;
    }

    const scopedBlock = scopeSelectorBlock(line);
    scopedLines.push(scopedBlock);
    const delta = braceDelta(scopedBlock);
    blockDepth += delta;
    declarationDepth += delta;
  }

  scopedLines.push(...pendingSelectorLines);
  return `${scopedLines.join("\n")}\n`;
}

function braceDelta(value) {
  const opens = value.match(/\{/g)?.length ?? 0;
  const closes = value.match(/\}/g)?.length ?? 0;
  return opens - closes;
}

function scopeSelectorBlock(block) {
  const openBraceIndex = block.indexOf("{");
  const selectorText = block.slice(0, openBraceIndex);
  const rest = block.slice(openBraceIndex);
  const scopedSelectorText = splitSelectorList(selectorText)
    .map((selector) => scopeSelector(selector))
    .join(",");

  return `${scopedSelectorText}${rest}`;
}

// Split a selector list on its top-level commas only. The commas inside
// :where(:not(a, b)) / :is(...) belong to one compound selector: scoping each
// fragment would inject the embed class inside the argument list and change
// what the selector matches (@kontourai/ui 1.17's nearest-scope selectors).
function splitSelectorList(selectorText) {
  const selectors = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selectorText.length; index += 1) {
    const char = selectorText[index];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      selectors.push(selectorText.slice(start, index));
      start = index + 1;
    }
  }
  if (depth !== 0) throw new Error(`Unbalanced selector list: ${selectorText.trim()}`);
  selectors.push(selectorText.slice(start));
  return selectors;
}

function scopeSelector(selector) {
  const leadingWhitespace = selector.match(/^\s*/)?.[0] ?? "";
  const trimmed = selector.trim();

  if (
    trimmed === ""
    || trimmed.startsWith("@")
    || trimmed === "from"
    || trimmed === "to"
    || /^\d+%$/.test(trimmed)
  ) {
    return selector;
  }

  if (trimmed === ":root" || trimmed === "body") {
    return `${leadingWhitespace}.survey-workbench-embed`;
  }

  if (trimmed.startsWith("[data-theme")) {
    return `${leadingWhitespace}.survey-workbench-embed${trimmed}`;
  }

  if (trimmed.startsWith("body")) {
    return `${leadingWhitespace}.survey-workbench-embed${trimmed.slice("body".length)}`;
  }

  if (trimmed.startsWith(".theme-")) {
    return `${leadingWhitespace}.survey-workbench-embed${trimmed}`;
  }

  if (trimmed === "*") {
    return `${leadingWhitespace}.survey-workbench-embed *`;
  }

  if (trimmed.startsWith(".survey-workbench-embed")) {
    return selector;
  }

  return `${leadingWhitespace}.survey-workbench-embed ${trimmed}`;
}
