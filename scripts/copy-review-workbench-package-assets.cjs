const fs = require("node:fs/promises");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const sourceRoot = path.join(root, "examples", "review-workbench");
const distRoot = path.join(root, "dist", "src", "review-workbench");

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await fs.mkdir(distRoot, { recursive: true });
  await fs.copyFile(
    path.join(sourceRoot, "review-workbench.css"),
    path.join(distRoot, "review-workbench.standalone.css"),
  );
  await fs.writeFile(
    path.join(distRoot, "review-workbench.css"),
    await buildEmbeddedWorkbenchCss(),
  );
  await fs.cp(
    path.join(sourceRoot, "vendor"),
    path.join(distRoot, "vendor"),
    { recursive: true },
  );
}

async function buildEmbeddedWorkbenchCss() {
  const tokenRoot = path.join(sourceRoot, "vendor", "console-kit", "tokens");
  const fontsCss = await fs.readFile(path.join(tokenRoot, "fonts.css"), "utf8");
  const tokensCss = await fs.readFile(path.join(tokenRoot, "tokens.css"), "utf8");
  const themesCss = await fs.readFile(path.join(tokenRoot, "themes.css"), "utf8");
  const workbenchCss = await fs.readFile(path.join(sourceRoot, "review-workbench.css"), "utf8");
  const scopedWorkbenchCss = containEmbeddedWorkbenchOverlay(
    scopeCssForEmbeddedWorkbench(stripCssImports(workbenchCss)),
  );

  return [
    "/* Bundled, scoped Survey Review Workbench styles for downstream embeds. */",
    fontsCss,
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

function stripCssImports(css) {
  return css
    .split("\n")
    .filter((line) => !line.trim().startsWith("@import "))
    .join("\n");
}

function containEmbeddedWorkbenchOverlay(css) {
  return css.replace(
    /(\.survey-workbench-embed::before\{\n(?:.*\n)*?)  position: fixed;/,
    "$1  position: absolute;",
  );
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
  const scopedSelectorText = selectorText
    .split(",")
    .map((selector) => scopeSelector(selector))
    .join(",");

  return `${scopedSelectorText}${rest}`;
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
