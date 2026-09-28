/**
 * Consumer install check for the `@kontourai/surface` dependency range (#291).
 *
 * Packs this package, installs the tarball into a fresh npm consumer that also
 * depends on the Surface range given as the first argument (default `^3`),
 * and fails unless the consumer ends up with exactly one copy of Surface.
 * A second, nested copy means Survey's declared range excludes the consumer's
 * Surface major, so Survey would run on a different Surface instance than the
 * consumer validates with.
 *
 *   node scripts/check-surface-single-copy.mjs [surface-spec]
 *
 * Needs registry access. Not part of `npm run verify`; CI runs it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const surfaceSpec = process.argv[2] ?? "^3";
const repoRoot = resolve(import.meta.dirname, "..");
const work = mkdtempSync(join(tmpdir(), "survey-surface-consumer-"));

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function listing(consumerDir) {
  try {
    return run("npm", ["ls", "@kontourai/surface", "--all", "--parseable", "--long"], consumerDir);
  } catch (error) {
    // npm ls exits non-zero on an invalid tree but still prints it.
    return String(error.stdout ?? "");
  }
}

try {
  const packDir = join(work, "pack");
  const consumerDir = join(work, "consumer");
  run("mkdir", ["-p", packDir, consumerDir]);
  // Build first so the pack step's lifecycle output cannot mix into its JSON.
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], repoRoot));
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "surface-consumer-fixture", private: true, version: "0.0.0" }));
  run("npm", ["install", "--no-audit", "--no-fund", join(packDir, packed.filename), `@kontourai/surface@${surfaceSpec}`], consumerDir);

  // --parseable prints one line per tree reference as `<install dir>:<name@version>`;
  // a deduped reference repeats its install dir, so distinct dirs are copies.
  const copies = [...new Map(listing(consumerDir).split("\n")
    .map((line) => /^(.*):(@kontourai\/surface@[^:]+)(?::|$)/.exec(line.trim()))
    .filter((match) => match !== null)
    .map((match) => [match[1], { path: match[1], version: match[2].slice("@kontourai/surface@".length) }])).values()];
  const versions = [...new Set(copies.map((copy) => copy.version))];
  for (const copy of copies) console.log(`${copy.version}  ${copy.path}`);
  if (copies.length !== 1) {
    console.error(`FAIL: a consumer on @kontourai/surface@${surfaceSpec} installs ${copies.length} Surface copies (${versions.join(", ")}); expected exactly one.`);
    process.exitCode = 1;
  } else {
    console.log(`OK: a consumer on @kontourai/surface@${surfaceSpec} installs one Surface copy (${versions[0]}).`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
