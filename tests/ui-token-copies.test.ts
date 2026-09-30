/**
 * Survey keeps two hand-written token blocks that cannot load @kontourai/ui:
 * the docs site's stylesheet and the MCP review card's inline <style>. This
 * holds their literal values to the installed package, so a ui retint (such
 * as 1.18's survey light brand, kontourai/survey#323) fails here instead of
 * drifting silently. Deliberate brand variants are allowlisted, each mapped to
 * the themes.css rule it must still equal.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { readRuleDeclarations } = require(path.resolve("scripts/copy-review-workbench-package-assets.cjs")) as {
  readRuleDeclarations(css: string, matches: (selectors: string[]) => boolean, description: string): Map<string, string>;
};

type Mode = "dark" | "light";

async function packageRule(file: string, matches: (selectors: string[]) => boolean, description: string) {
  const css = await readFile(path.resolve("node_modules/@kontourai/ui/tokens", file), "utf8");
  return readRuleDeclarations(css, matches, description);
}
const exactly = (selector: string) => (selectors: string[]) => selectors.length === 1 && selectors[0] === selector;

const reference = {
  dark: () => packageRule("tokens.css", exactly(":root"), ":root"),
  light: () => packageRule("tokens.css", exactly('[data-theme="light"]'), '[data-theme="light"]'),
  surfaceDark: () => packageRule("themes.css", exactly(".theme-surface"), ".theme-surface"),
  surveyLight: () => packageRule(
    "themes.css",
    (selectors) => selectors[0] === '[data-theme="light"].theme-survey',
    '[data-theme="light"].theme-survey',
  ),
};

interface Variant { readonly rule: keyof typeof reference; readonly token: string }

const copies: ReadonlyArray<{ file: string; variants: Partial<Record<Mode, Record<string, Variant>>> }> = [
  {
    file: "scripts/docs-site/styles.css",
    variants: {
      // The docs site brands itself with the surface accent in dark mode, and
      // --k-brand-bright (link and accent text) is not a ui token.
      dark: {
        "--k-brand": { rule: "surfaceDark", token: "--k-brand" },
        "--k-brand-bright": { rule: "dark", token: "--k-brand" },
      },
      light: {
        "--k-brand": { rule: "surveyLight", token: "--k-brand" },
        "--k-brand-bright": { rule: "surveyLight", token: "--k-brand" },
      },
    },
  },
  {
    file: "src/mcp/review-mcp.ts",
    variants: { light: { "--k-brand": { rule: "surveyLight", token: "--k-brand" } } },
  },
];

/** The first `:root { … }` block (dark) and the one inside `prefers-color-scheme: light`. */
function literalBlocks(source: string): Record<Mode, Map<string, string>> {
  const dark = source.match(/:root\s*\{([^}]*)\}/);
  const light = source.match(/prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/);
  assert.ok(dark && light, "expected a :root block and a prefers-color-scheme: light :root block");
  const parse = (body: string) => new Map(
    [...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--k-[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!]),
  );
  return { dark: parse(dark[1]!), light: parse(light[1]!) };
}

const normalize = (value: string) => value.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim().toLowerCase();

describe("hand-written token copies match the installed @kontourai/ui", () => {
  for (const { file, variants } of copies) {
    for (const mode of ["dark", "light"] as const) {
      it(`${file} (${mode})`, async () => {
        const blocks = literalBlocks(await readFile(file, "utf8"));
        const base = await reference[mode]();
        const allowed = variants[mode] ?? {};
        let compared = 0;
        for (const [name, value] of blocks[mode]) {
          const variant = allowed[name];
          const expected = variant ? (await reference[variant.rule]()).get(variant.token) : base.get(name);
          if (expected === undefined) continue; // not a ui token (layout-only, e.g. --header-h)
          assert.equal(normalize(value), normalize(expected), `${file} ${mode} ${name}`);
          compared += 1;
        }
        for (const name of Object.keys(allowed)) assert.ok(blocks[mode].has(name), `${file} ${mode} no longer declares allowlisted ${name}`);
        assert.ok(compared >= 8, `${file} ${mode}: only ${compared} tokens compared`);
      });
    }
  }
});
